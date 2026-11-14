import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { ffmpegPath } from '../ffmpeg'
import { buildGraph } from './graph'
import type {
  AudioFormat,
  ExportKind,
  ExportOptions,
  ExportProgress,
  ExportState,
  GifDither,
  Project
} from '@shared/types'

export interface ExportPresetSpec {
  label: string
  /** Target height; width follows the source aspect ratio. */
  height: number | null
  crf: number
  preset: string
  audioKbps: number
}

export const PRESETS: Record<string, ExportPresetSpec> = {
  web: { label: '网络 (1080p)', height: 1080, crf: 23, preset: 'veryfast', audioKbps: 160 },
  high: { label: '高质量 (原始分辨率)', height: null, crf: 18, preset: 'slow', audioKbps: 256 },
  master: { label: '母版 (高质量归档)', height: null, crf: 16, preset: 'veryslow', audioKbps: 320 }
}

/** The container and codec an audio-only export is written in. */
export interface AudioFormatSpec {
  label: string
  ext: string
  codec: string[]
  /** The lossy formats take a bitrate; the others do not. */
  lossless?: boolean
  /** The bitrate used when the caller does not name one. */
  defaultKbps: number
}

export const AUDIO_FORMATS: Record<AudioFormat, AudioFormatSpec> = {
  mp3: {
    label: 'MP3',
    ext: 'mp3',
    codec: ['-c:a', 'libmp3lame'],
    defaultKbps: 192
  },
  wav: {
    label: 'WAV',
    ext: 'wav',
    codec: ['-c:a', 'pcm_s16le'],
    lossless: true,
    defaultKbps: 0
  },
  m4a: {
    label: 'M4A',
    ext: 'm4a',
    codec: ['-c:a', 'aac'],
    defaultKbps: 256
  },
  flac: {
    label: 'FLAC',
    ext: 'flac',
    codec: ['-c:a', 'flac'],
    lossless: true,
    defaultKbps: 0
  }
}

/** How the palette of an animated GIF is smoothed. */
const GIF_DITHER: Record<GifDither, string> = {
  none: 'dither=none',
  bayer: 'dither=bayer:bayer_scale=5',
  sierra2: 'dither=sierra2_4a'
}

/** What an export run hands over to FFmpeg. */
interface ExportPlan {
  args: string[]
  duration: number
}

export class ExportRunner extends EventEmitter {
  private child: ChildProcess | null = null
  private cancelled = false

  get running(): boolean {
    return this.child !== null
  }

  cancel(): void {
    if (!this.child) return
    this.cancelled = true
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }

  async run(project: Project, options: ExportOptions): Promise<void> {
    const bin = ffmpegPath()
    if (!bin) throw new Error('ffmpeg not found — install FFmpeg or set CLIPFORGE_FFMPEG')

    this.cancelled = false
    this.emit('state', state('preparing', '正在准备导出…', 0))

    const kind: ExportKind = options.kind ?? 'video'
    let plan: ExportPlan
    try {
      plan = buildPlan(project, options, kind)
    } catch (err) {
      // The run never starts, so the failure has to be reported here —
      // otherwise the dialog would wait for a progress that never comes.
      const message = err instanceof Error ? err.message : String(err)
      this.emit('state', {
        status: 'error',
        progress: {
          progress: 0,
          outTime: 0,
          duration: 0,
          speed: '',
          fps: 0,
          bitrate: '',
          totalSize: '',
          eta: ''
        },
        message,
        log: []
      })
      throw new Error(message)
    }

    const args = [...plan.args, '-progress', 'pipe:1', '-stats_period', '0.25', options.path]

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const log: string[] = []
    const progress: ExportProgress = {
      progress: 0,
      outTime: 0,
      duration: plan.duration,
      speed: '',
      fps: 0,
      bitrate: '',
      totalSize: '',
      eta: ''
    }

    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderrTail = (stderrTail + text).slice(-8000)
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
      for (const line of lines) {
        log.push(line)
        if (log.length > 400) log.shift()
      }
    })

    // `-progress pipe:1` emits `key=value` pairs on stdout.
    let buffer = ''
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const key = line.slice(0, eq).trim()
        const value = line.slice(eq + 1).trim()

        if (key === 'out_time_us' || key === 'out_time_ms') {
          const micros = Number(value)
          if (Number.isFinite(micros)) progress.outTime = micros / 1_000_000
        } else if (key === 'out_time') {
          const t = parseTime(value)
          if (t !== null) progress.outTime = t
        } else if (key === 'speed') {
          progress.speed = value
        } else if (key === 'fps') {
          progress.fps = Number(value) || 0
        } else if (key === 'bitrate') {
          progress.bitrate = value.trim()
        } else if (key === 'total_size') {
          progress.totalSize = formatSize(Number(value) || 0)
        } else if (key === 'progress') {
          if (plan.duration > 0) {
            progress.progress = Math.min(1, progress.outTime / plan.duration)
          }
          progress.eta = estimateEta(progress.outTime, plan.duration, progress.speed)
          this.emit('progress', { ...progress })
          this.emit('state', {
            status: value === 'end' ? 'done' : 'running',
            progress: { ...progress },
            message: value === 'end' ? '导出完成' : `正在导出 ${(progress.progress * 100).toFixed(0)}%`,
            log: [...log]
          })
        }
      }
    })

    await new Promise<void>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (code) => {
        this.child = null
        if (this.cancelled) {
          this.emit('state', {
            status: 'cancelled',
            progress: { ...progress },
            message: '导出已取消',
            log: [...log]
          })
          resolve()
          return
        }
        if (code === 0) {
          progress.progress = 1
          this.emit('state', {
            status: 'done',
            progress: { ...progress },
            message: '导出完成',
            log: [...log],
            outputPath: options.path
          })
          resolve()
          return
        }
        const message = extractError(stderrTail)
        this.emit('state', {
          status: 'error',
          progress: { ...progress },
          message: message || `导出失败（退出码 ${code}）`,
          log: [...log]
        })
        reject(new Error(message || `ffmpeg exited with code ${code}`))
      })
    })
  }
}

/** H.264 requires even pixel dimensions. */
function even(value: number): number {
  const n = Math.max(2, Math.round(value))
  return n % 2 === 0 ? n : n - 1
}

/**
 * Turns the options into the FFmpeg command line.
 *
 * The three kinds share the same project and differ only in what is written
 * out: the picture, the mixed sound or an animated GIF of the picture.
 */
function buildPlan(
  project: Project,
  options: ExportOptions,
  kind: ExportKind
): ExportPlan {
  if (kind === 'audio') return planAudio(project, options)
  if (kind === 'gif') return planGif(project, options)
  return planVideo(project, options)
}

/** A video file: the composition, scaled to the wanted size, in H.264. */
function planVideo(project: Project, options: ExportOptions): ExportPlan {
  const spec = PRESETS[options.preset] ?? PRESETS.web
  const src = project.settings

  // The `web` preset caps the height at 1080p, keeping the aspect ratio.
  // H.264 needs even dimensions, so the width is rounded down to match.
  const cappedH = spec.height !== null && src.height > spec.height ? spec.height : src.height
  const scaledW = Math.round((src.width / src.height) * cappedH)
  const outW = even(options.width ?? scaledW)
  const outH = even(options.height ?? cappedH)
  const outFps = options.fps ?? src.fps

  const graph = buildGraph(project, { video: true, audio: true })

  // The graph is authored against the project resolution; when the export
  // resolution differs we scale the finished composition.
  const needsRescale = outW !== src.width || outH !== src.height
  const filterComplex = needsRescale
    ? `${graph.filterComplex};[${graph.videoLabel}]scale=${outW}:${outH}:` +
      `force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,` +
      `setsar=1[vscaled]`
    : graph.filterComplex
  const videoLabel = needsRescale ? 'vscaled' : graph.videoLabel

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...graph.inputArgs,
    '-filter_complex', filterComplex,
    '-map', `[${videoLabel}]`
  ]
  if (graph.audioLabel) args.push('-map', `[${graph.audioLabel}]`)
  else args.push('-an')

  args.push('-c:v', 'libx264', '-preset', spec.preset)
  if (options.bitrate) args.push('-b:v', `${options.bitrate}k`)
  else args.push('-crf', String(spec.crf))
  args.push('-pix_fmt', 'yuv420p', '-r', String(outFps), '-movflags', '+faststart')
  if (graph.audioLabel) {
    args.push('-c:a', 'aac', '-b:a', `${spec.audioKbps}k`, '-ar', '48000')
  }

  return { args, duration: graph.duration }
}

/** An audio file: the mix of every clip that carries sound. */
function planAudio(project: Project, options: ExportOptions): ExportPlan {
  const format = options.audioFormat ?? 'mp3'
  const spec = AUDIO_FORMATS[format]
  if (!spec) throw new Error(`未知的音频格式：${format}`)

  // The picture is left out of the graph: it would only be decoded and
  // thrown away again.
  const graph = buildGraph(project, { video: false, audio: true })
  if (!graph.audioLabel) throw new Error('时间轴上没有可以导出的声音')

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...graph.inputArgs,
    '-filter_complex', graph.filterComplex,
    '-map', `[${graph.audioLabel}]`,
    ...spec.codec
  ]
  if (!spec.lossless) {
    args.push('-b:a', `${options.audioBitrate ?? spec.defaultKbps}k`)
  }
  args.push('-ar', '48000')

  return { args, duration: graph.duration }
}

/** An animated GIF of the composition. */
function planGif(project: Project, options: ExportOptions): ExportPlan {
  const gif = options.gif ?? { width: 480, fps: 15, loop: 0, dither: 'bayer' }
  const src = project.settings

  const graph = buildGraph(project, { video: true, audio: false })
  if (!graph.videoLabel) throw new Error('时间轴上没有可以导出的画面')

  // A GIF is a picture book: it is small, it plays at a few frames per
  // second and it has a palette of its own.
  const outW = even(Math.min(gif.width, src.width))
  const outH = even(Math.max(2, Math.round((src.height / src.width) * outW)))
  const fps = Math.max(1, Math.round(gif.fps))

  const filterComplex = [
    `${graph.filterComplex};[${graph.videoLabel}]fps=${fps},` +
      `scale=${outW}:${outH}:flags=lanczos,split[gs0][gs1]`,
    '[gs0]palettegen=max_colors=256[gp]',
    `[gs1][gp]paletteuse=${GIF_DITHER[gif.dither] ?? GIF_DITHER.bayer}[gifout]`
  ].join(';')

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...graph.inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[gifout]',
    // 0 lets the GIF run forever, -1 plays it exactly once.
    '-loop', String(gif.loop),
    '-r', String(fps)
  ]

  return { args, duration: graph.duration }
}

function parseTime(value: string): number | null {
  const parts = value.split(':').map(Number)
  if (parts.some((p) => !Number.isFinite(p))) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? null
}

function estimateEta(outTime: number, duration: number, speed: string): string {
  if (duration <= 0 || outTime <= 0) return '--:--'
  const speedNum = parseFloat(speed)
  const remaining = Math.max(0, duration - outTime)
  const seconds = Number.isFinite(speedNum) && speedNum > 0 ? remaining / speedNum : remaining
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 KB'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function extractError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((l) => /error|invalid|unable|failed|no such|conversion|not found/i.test(l))
  return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
}

function state(
  status: ExportState['status'],
  message: string,
  progress: number
): ExportState {
  return {
    status,
    progress: {
      progress,
      outTime: 0,
      duration: 0,
      speed: '',
      fps: 0,
      bitrate: '',
      totalSize: '',
      eta: ''
    },
    message,
    log: []
  }
}
