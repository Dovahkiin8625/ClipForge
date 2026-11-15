import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { ffmpegPath } from './ffmpeg'
import { probeFile } from './media/probe'
import { FORMATS, QUALITY_CRF, type FormatSpec } from '@shared/convertFormats'
import type {
  ConvertOptions,
  ConvertProgress,
  ConvertState
} from '@shared/types'

/**
 * Transcodes a single file.
 *
 * The runner is deliberately separate from the export pipeline: an export
 * mixes a whole timeline into one picture, while a conversion re-encodes one
 * file that already exists on disk. What they share — the FFmpeg binary, the
 * progress protocol — is small enough that a second runner is cheaper than
 * bending the export one into two shapes.
 */
export class ConvertRunner extends EventEmitter {
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

  async run(options: ConvertOptions): Promise<void> {
    const bin = ffmpegPath()
    if (!bin) throw new Error('ffmpeg not found — install FFmpeg or set CLIPFORGE_FFMPEG')

    const spec = FORMATS[options.format]
    if (!spec) throw new Error(`未知的格式：${options.format}`)

    this.cancelled = false

    let args: string[]
    let duration: number
    try {
      const plan = await buildPlan(options, spec)
      args = plan.args
      duration = plan.duration
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('state', state('error', message))
      throw new Error(message)
    }

    const output = uniquePath(join(options.outputDir, `${options.fileName}.${spec.ext}`))

    const child = spawn(
      bin,
      [...args, '-progress', 'pipe:1', '-stats_period', '0.25', output],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    this.child = child

    const log: string[] = []
    const progress: ConvertProgress = {
      progress: 0,
      outTime: 0,
      duration,
      speed: '',
      eta: '--:--'
    }

    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderrTail = (stderrTail + text).slice(-8000)
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        log.push(line)
        if (log.length > 400) log.shift()
      }
    })

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
        } else if (key === 'progress') {
          if (duration > 0) {
            progress.progress = Math.min(1, progress.outTime / duration)
          }
          progress.eta = estimateEta(progress.outTime, duration, progress.speed)
          this.emit('progress', { ...progress })
          // The run is only finished once FFmpeg has closed; its last
          // progress line arrives before that, so it still counts as running.
          this.emit('state', {
            status: 'running',
            progress: { ...progress },
            message: `正在转换 ${(progress.progress * 100).toFixed(0)}%`,
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
            message: '转换已取消',
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
            message: '转换完成',
            log: [...log],
            outputPath: output
          })
          resolve()
          return
        }
        const message = extractError(stderrTail)
        this.emit('state', {
          status: 'error',
          progress: { ...progress },
          message: message || `转换失败（退出码 ${code}）`,
          log: [...log]
        })
        reject(new Error(message || `ffmpeg exited with code ${code}`))
      })
    })
  }
}

interface Plan {
  args: string[]
  duration: number
}

/**
 * Turns the options into an FFmpeg command line.
 *
 * The source is probed first so that the progress bar knows how long the
 * file is and so that a half-width scale can be resolved against the real
 * aspect ratio.
 */
async function buildPlan(
  options: ConvertOptions,
  spec: FormatSpec
): Promise<Plan> {
  const probe = await probeFile(options.input)
  const sourceDuration = probe.duration
  const audioOnly = spec.media === 'audio'

  const args: string[] = ['-hide_banner', '-nostdin', '-y']
  if (options.start && options.start > 0) args.push('-ss', String(options.start))
  args.push('-i', options.input)
  if (options.duration && options.duration > 0) args.push('-t', String(options.duration))

  const length = options.duration && options.duration > 0
    ? options.duration
    : Math.max(0, sourceDuration - (options.start ?? 0))

  const filters: string[] = []

  // The scale is only needed when the target size differs from the source.
  const wantWidth = options.width ?? 0
  const wantHeight = options.height ?? 0
  if (wantWidth > 0 || wantHeight > 0) {
    const outW = even(wantWidth > 0 ? wantWidth : scaled(wantHeight, probe.width, probe.height))
    const outH = even(wantHeight > 0 ? wantHeight : scaled(wantWidth, probe.height, probe.width))
    filters.push(
      `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,` +
        `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2`
    )
  }
  if (options.fps && options.fps > 0) filters.push(`fps=${options.fps}`)

  const crf = QUALITY_CRF[options.quality ?? 'medium'] ?? 23

  if (audioOnly) {
    const codec = options.audioCodec ?? spec.defaultAudioCodec ?? 'aac'
    args.push('-vn')
    args.push('-c:a', codec)
    if (isLossyAudio(codec)) {
      args.push('-b:a', `${options.audioBitrate ?? 192}k`)
    }
    args.push('-ar', '48000')
    return { args, duration: length }
  }

  const videoCodec = options.videoCodec ?? spec.defaultVideoCodec ?? 'libx264'

  if (videoCodec === 'gif') {
    // A GIF is a picture book: it has its own frame rate and its own palette.
    const gifFilters = ['fps=15']
    if (filters.length) gifFilters.push(...filters)
    else gifFilters.push('scale=-2:-1:flags=lanczos')
    const chain = [...gifFilters, 'split[gs0][gs1]']
    args.push(
      '-filter_complex',
      `${chain.join(',')};[gs0]palettegen=max_colors=256[gp];` +
        '[gs1][gp]paletteuse=dither=bayer:bayer_scale=5[gifout]',
      '-map', '[gifout]',
      '-loop', '0'
    )
    return { args, duration: length }
  }

  if (filters.length) args.push('-vf', filters.join(','))

  args.push('-c:v', videoCodec)
  if (videoCodec === 'prores') {
    args.push('-profile:v', '3', '-pix_fmt', 'yuv422p10le')
  } else {
    args.push('-crf', String(crf))
    args.push('-pix_fmt', 'yuv420p')
  }
  // Only the MP4 family knows the faststart flag; the others would warn.
  if (['mp4', 'mov', 'm4a'].includes(options.format)) {
    args.push('-movflags', '+faststart')
  }

  const audioCodec = options.audioCodec ?? spec.defaultAudioCodec ?? 'aac'
  if (!probe.hasAudio) {
    args.push('-an')
  } else {
    args.push('-c:a', audioCodec)
    if (isLossyAudio(audioCodec)) {
      args.push('-b:a', `${options.audioBitrate ?? 192}k`)
    }
    args.push('-ar', '48000')
  }

  return { args, duration: length }
}

/**
 * Keeps an existing file out of the way.
 *
 * A converter that overwrites whatever sits at the target path is a
 * converter that eats work; a number is added to the name instead.
 */
function uniquePath(target: string): string {
  if (!existsSync(target)) return target
  const dir = dirname(target)
  const ext = extname(target)
  const stem = basename(target, ext)
  for (let i = 1; i < 100; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  return target
}

function isLossyAudio(codec: string): boolean {
  return ['aac', 'libmp3lame', 'libopus', 'libvorbis'].includes(codec)
}

/** H.264 and friends need even pixel dimensions. */
function even(value: number): number {
  const n = Math.max(2, Math.round(value))
  return n % 2 === 0 ? n : n - 1
}

/** Derives the missing side of a scale from the source aspect ratio. */
function scaled(known: number, srcA: number, srcB: number): number {
  if (known <= 0 || srcA <= 0 || srcB <= 0) return known
  return (srcA / srcB) * known
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

function extractError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((l) => /error|invalid|unable|failed|no such|conversion|not found/i.test(l))
  return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
}

function state(status: ConvertState['status'], message: string): ConvertState {
  return {
    status,
    progress: { progress: 0, outTime: 0, duration: 0, speed: '', eta: '--:--' },
    message,
    log: []
  }
}
