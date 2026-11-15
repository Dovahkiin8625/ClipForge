import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type {
  DownloadOptions,
  DownloadProgress,
  VideoFormatOption,
  VideoInfo,
  YtdlpInfo
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* Locating yt-dlp                                                     */
/* ------------------------------------------------------------------ */

const SETTINGS_FILE = 'settings.json'

interface Settings {
  ytdlpPath?: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

function readSettings(): Settings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Settings
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSettings(patch: Settings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }, null, 2), 'utf8')
  } catch {
    /* the choice is a convenience, not a requirement */
  }
}

function which(bin: string): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, [bin], { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return null
  const first = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)
  return first ? first.trim() : null
}

/**
 * The command that runs yt-dlp.
 *
 * The environment override may carry arguments (`python -m yt_dlp`), so it
 * is split into the binary and the arguments that come before every call.
 */
export interface YtdlpCommand {
  bin: string
  prefix: string[]
}

function splitCommand(raw: string): YtdlpCommand {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  return { bin: parts[0] ?? raw.trim(), prefix: parts.slice(1) }
}

/**
 * Finds the yt-dlp binary.
 *
 * The order follows how likely the user is to have it: an explicit
 * environment override, the path they picked in the app, the copy shipped
 * with the packaged build, and finally the system PATH.
 */
export function ytdlpCommand(): YtdlpCommand | null {
  const env = process.env['CLIPFORGE_YTDLP']
  if (env) {
    const cmd = splitCommand(env)
    if (cmd.bin) {
      // The override may name a program rather than a path.
      const resolved = existsSync(cmd.bin) ? cmd.bin : which(cmd.bin)
      if (resolved) return { bin: resolved, prefix: cmd.prefix }
    }
  }

  const chosen = readSettings().ytdlpPath
  if (chosen && existsSync(chosen)) return { bin: chosen, prefix: [] }

  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'bin', 'yt-dlp.exe')
    if (existsSync(bundled)) return { bin: bundled, prefix: [] }
  }

  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']
  const onPath = names.map((n) => which(n)).find((p): p is string => !!p)
  if (onPath) return { bin: onPath, prefix: [] }

  return null
}

export function ytdlpPath(): string | null {
  return ytdlpCommand()?.bin ?? null
}

/** Remembers a yt-dlp binary the user picked by hand. */
export function rememberYtdlp(path: string): void {
  writeSettings({ ytdlpPath: path })
}

export function ytdlpInfo(): YtdlpInfo {
  const cmd = ytdlpCommand()
  if (!cmd) {
    return {
      available: false,
      path: '',
      version: '',
      hint:
        '未找到 yt-dlp。下载功能需要它来读取链接信息。' +
        '请从 https://github.com/yt-dlp/yt-dlp/releases 下载后，' +
        '点击「指定路径」选择该可执行文件。'
    }
  }
  const r = spawnSync(cmd.bin, [...cmd.prefix, '--version'], {
    encoding: 'utf8',
    timeout: 10000
  })
  const version = (r.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
  return { available: true, path: cmd.bin, version, hint: '' }
}

/* ------------------------------------------------------------------ */
/* Reading a link                                                      */
/* ------------------------------------------------------------------ */

interface YtdlpFormat {
  format_id?: string
  ext?: string
  width?: number
  height?: number
  fps?: number
  filesize?: number
  filesize_approx?: number
  vcodec?: string
  acodec?: string
  format_note?: string
  protocol?: string
}

interface YtdlpJson {
  title?: string
  thumbnail?: string
  duration?: number
  extractor?: string
  formats?: YtdlpFormat[]
  format_id?: string
  ext?: string
  width?: number
  height?: number
  fps?: number
  filesize?: number
}

/**
 * Reads what a link offers without downloading anything.
 *
 * Only the renditions that carry a picture are offered: the download is for
 * footage, and the audio-only streams are better reached through the
 * conversion workspace.
 */
export async function parseVideo(url: string): Promise<VideoInfo> {
  const cmd = ytdlpCommand()
  if (!cmd) throw new Error(ytdlpInfo().hint)

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      cmd.bin,
      [
        ...cmd.prefix,
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--ignore-errors',
        url
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`))
    })
  })

  let parsed: YtdlpJson
  try {
    parsed = JSON.parse(raw) as YtdlpJson
  } catch {
    throw new Error('yt-dlp 返回了无法解析的内容')
  }

  const formats: VideoFormatOption[] = []
  const seen = new Set<string>()

  const push = (f: YtdlpFormat): void => {
    const id = f.format_id ?? ''
    if (!id || seen.has(id)) return
    if (!f.vcodec || f.vcodec === 'none') return
    seen.add(id)
    formats.push({
      id,
      label: formatLabel(f),
      ext: f.ext ?? 'mp4',
      width: f.width ?? 0,
      height: f.height ?? 0,
      fps: f.fps ?? 0,
      sizeBytes: f.filesize ?? f.filesize_approx ?? 0,
      hasAudio: !!f.acodec && f.acodec !== 'none'
    })
  }

  for (const f of parsed.formats ?? []) push(f)

  // A site that only offers one rendition reports it at the top level.
  if (formats.length === 0 && parsed.format_id) {
    push({
      format_id: parsed.format_id,
      ext: parsed.ext,
      width: parsed.width,
      height: parsed.height,
      fps: parsed.fps,
      filesize: parsed.filesize,
      vcodec: 'h264',
      acodec: 'aac'
    })
  }

  formats.sort((a, b) => b.height - a.height || b.fps - a.fps)

  return {
    url,
    title: parsed.title ?? '未命名',
    thumbnail: parsed.thumbnail,
    duration: parsed.duration ?? 0,
    extractor: parsed.extractor ?? '',
    formats
  }
}

function formatLabel(f: YtdlpFormat): string {
  const height = f.height ?? 0
  const size = height ? `${height}p` : f.format_note ?? f.ext ?? 'video'
  const fps = f.fps && Math.round(f.fps) > 30 ? `${Math.round(f.fps)}fps` : ''
  return [size, fps].filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ */
/* Downloading                                                          */
/* ------------------------------------------------------------------ */

/**
 * The progress line yt-dlp prints.
 *
 * The template is used instead of the human-readable output because the
 * numbers in it are stable; the human output changes its wording between
 * releases and mixes progress with warnings.
 */
const PROGRESS_TEMPLATE =
  'dlp:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|' +
  '%(progress._total_bytes_str)s|%(progress._downloaded_bytes_str)s'

export class DownloadRunner extends EventEmitter {
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

  async run(options: DownloadOptions): Promise<void> {
    const cmd = ytdlpCommand()
    if (!cmd) throw new Error(ytdlpInfo().hint)

    this.cancelled = false
    this.emit('state', {
      status: 'running',
      message: '正在准备下载…',
      progress: { progress: 0, speed: '', eta: '--:--', totalSize: '', downloaded: '' }
    })

    const template = options.fileName
      ? `${options.fileName}.%(ext)s`
      : '%(title)s.%(ext)s'

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--print',
      'after_move:%(filepath)s',
      '-o',
      join(options.outputDir, template)
    ]
    if (options.formatId) args.push('-f', options.formatId)
    args.push(options.url)

    const child = spawn(cmd.bin, [...cmd.prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    const progress: DownloadProgress = {
      progress: 0,
      speed: '',
      eta: '--:--',
      totalSize: '',
      downloaded: ''
    }

    let stderrTail = ''
    child.stderr.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000)
    })

    let outputPath = ''
    let buffer = ''
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        if (text.startsWith('dlp:')) {
          applyProgress(text.slice(4), progress)
          this.emit('state', {
            status: 'running',
            message: `正在下载 ${(progress.progress * 100).toFixed(0)}%`,
            progress: { ...progress }
          })
          continue
        }
        // The only other thing on stdout is the finished file's path.
        if (existsSync(text)) outputPath = text
      }
    })

    await new Promise<void>((resolve, reject) => {
      child.on('error', (err) => reject(err))
      child.on('close', (code) => {
        this.child = null
        if (this.cancelled) {
          this.emit('state', {
            status: 'cancelled',
            message: '下载已取消',
            progress: { ...progress }
          })
          resolve()
          return
        }
        if (code === 0) {
          progress.progress = 1
          this.emit('state', {
            status: 'done',
            message: '下载完成',
            progress: { ...progress },
            outputPath
          })
          resolve()
          return
        }
        const message = cleanError(stderrTail) || `yt-dlp exited with code ${code}`
        this.emit('state', {
          status: 'error',
          message,
          progress: { ...progress }
        })
        reject(new Error(message))
      })
    })
  }
}

/** Reads one `dlp:` line into the progress record. */
function applyProgress(line: string, progress: DownloadProgress): void {
  const parts = line.split('|')
  const percent = (parts[0] ?? '').trim().replace('%', '').trim()
  const value = Number(percent)
  if (Number.isFinite(value)) progress.progress = Math.max(0, Math.min(1, value / 100))
  if (parts[1] !== undefined) progress.speed = parts[1].trim()
  if (parts[2] !== undefined) progress.eta = parts[2].trim() || '--:--'
  if (parts[3] !== undefined) progress.totalSize = parts[3].trim()
  if (parts[4] !== undefined) progress.downloaded = parts[4].trim()
}

function cleanError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /error|unsupported|unavailable|failed|not found|sign in|private/i.test(l))
  if (!lines.length) return ''
  return lines[lines.length - 1].slice(0, 300)
}
