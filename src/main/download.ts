import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { ffmpegPath } from './ffmpeg'
import { scanPage, type ScannedStream } from './pageScan'
import { ytdlpCommand, ytdlpInfo } from './ytdlp'
import type {
  DownloadFailure,
  DownloadOptions,
  DownloadProgress,
  VideoChoice,
  VideoEntry,
  VideoFormatOption,
  VideoList
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* Running yt-dlp                                                      */
/* ------------------------------------------------------------------ */

/**
 * Runs yt-dlp and hands back what it printed.
 *
 * A link that never answers must not leave the interface waiting for
 * ever, so the call is given a deadline.
 */
function runYtdlp(args: string[], timeoutMs = 90_000): Promise<string> {
  const cmd = ytdlpCommand()
  if (!cmd) throw new Error(ytdlpInfo().hint)

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd.bin, [...cmd.prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    let settled = false

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      if (!settled) {
        settled = true
        reject(new Error('读取链接超时，yt-dlp 没有在两分钟内回答'))
      }
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(e)
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (code === 0) resolve(out)
      else reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`))
    })
  })
}

async function parseJson(args: string[]): Promise<YtdlpJson> {
  const raw = await runYtdlp(args)
  try {
    return JSON.parse(raw) as YtdlpJson
  } catch {
    throw new Error('yt-dlp 返回了无法解析的内容')
  }
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
  tbr?: number
  vbr?: number
  abr?: number
  vcodec?: string
  acodec?: string
  format_note?: string
  protocol?: string
}

/** A format with the one thing it needs: an id. */
interface RawFormat extends YtdlpFormat {
  id: string
}

interface YtdlpJson {
  id?: string
  title?: string
  thumbnail?: string
  duration?: number
  extractor?: string
  formats?: YtdlpFormat[]
  entries?: YtdlpJson[]
  format_id?: string
  ext?: string
  width?: number
  height?: number
  fps?: number
  filesize?: number
}

/**
 * Whether a link names one video or a page with several of them.
 *
 * A watch page carries the video in its query string; a playlist, a
 * channel or a page with several parts does not. Getting this wrong means
 * either missing the other entries or expanding one video into a hundred.
 */
export function linkMode(url: string): 'single' | 'list' {
  try {
    const parsed = new URL(url)
    // A watch page names the video in the query string.
    if (parsed.searchParams.has('v')) return 'single'
    // Bilibili picks one part of a video with ?p=.
    if (parsed.searchParams.has('p')) return 'single'
    if (/\/shorts\//.test(parsed.pathname)) return 'single'
  } catch {
    // Not a link that can be taken apart; let yt-dlp have a look at it.
  }
  return 'list'
}

/**
 * Reads a link and lists everything on it that can be downloaded.
 *
 * A page may hold a single video, the several parts of one video, or a
 * whole playlist. The list is read without the details of every entry:
 * those are asked for when a video is picked, which keeps a long playlist
 * from taking a minute to open.
 *
 * A page that keeps its player in a JSON blob is empty to the extractor,
 * because the address of the stream is hidden in it. Such a page is read
 * by hand instead.
 */
export async function parseList(url: string): Promise<VideoList> {
  const mode = linkMode(url)
  const prefix = shortHash(url)

  let parsed: VideoList | null = null
  let failure: unknown = null
  try {
    parsed = await parseWithYtdlp(url, mode, prefix)
  } catch (err) {
    failure = err
  }

  if (parsed && !needsPageScan(parsed)) return parsed

  // The page itself is read: the streams it hides are found there.
  const scan = await scanPage(url)
  if (scan.streams.length > 0) {
    return scannedAsList(url, scan.streams, prefix)
  }

  if (parsed) return parsed

  // Both ways failed; the reasons are told together, so that it is clear
  // what is in the way.
  const first = failure instanceof Error ? failure.message : String(failure ?? '')
  const second = scan.error ? `页面也没读到（${scan.error}）` : ''
  const text =
    [first, second].filter(Boolean).join('；') || '这个链接里没有找到可以下载的视频'

  // The words yt-dlp prints are for somebody who knows it; a hint that
  // says what to do is added to them.
  const hint = classifyFailure('', text).hint
  throw new Error(`${text}\n${hint}`)
}

/** Reads a link with yt-dlp. */
async function parseWithYtdlp(
  url: string,
  mode: 'single' | 'list',
  prefix: string
): Promise<VideoList> {
  if (mode === 'single') {
    const json = await parseJson([
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      url
    ])
    const entry = entryFrom(json, 1, prefix)
    return {
      url,
      title: entry.title,
      extractor: json.extractor ?? '',
      mode,
      entries: [entry]
    }
  }

  const json = await parseJson([
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    url
  ])

  const raw = json.entries ?? []
  const entries = raw.map((item, i) => entryFrom(item, i + 1, prefix))
  if (entries.length === 0) {
    // The link did not look like a page with several videos, but it may
    // still hold exactly one. Whether its details came with the answer
    // or not, the entry is worth showing: the rest is read on demand.
    const single = entryFrom(json, 1, prefix)
    if (json.title || json.format_id || single.formats.length > 0) {
      entries.push(single)
    }
  }
  if (entries.length === 0) {
    throw new Error('这个链接里没有找到可以下载的视频')
  }

  return {
    url,
    title: json.title ?? entries[0].title,
    extractor: json.extractor ?? '',
    mode,
    entries
  }
}

/**
 * Whether the page has to be read by hand.
 *
 * A list of several entries is a list of videos, and the details of each
 * are read when they are wanted. A single entry without any quality is a
 * page that hid them, and so is a single entry whose streams are all
 * bare addresses: those are players on a page, each one a video of its
 * own.
 */
function needsPageScan(list: VideoList): boolean {
  if (list.entries.length === 0) return true
  if (list.entries.length > 1) return false
  const entry = list.entries[0]
  if (entry.choices.length === 0) return true
  const bare = entry.formats.filter((f) => !f.width && !f.height)
  return bare.length > 1 && bare.length === entry.formats.length
}

/**
 * Turns the streams that were found in a page into a list.
 */
export function scannedAsList(
  url: string,
  streams: ScannedStream[],
  prefix: string
): VideoList {
  const entries = streams.map((stream, i): VideoEntry => {
    const title =
      streams.length > 1 ? `${stream.title} · ${i + 1}` : stream.title
    return {
      index: i + 1,
      id: `${prefix}_${i + 1}_page`,
      title,
      duration: 0,
      mediaUrl: stream.url,
      formats: [],
      choices: [
        {
          id: 'direct',
          label: '直链流',
          ext: 'mp4',
          width: 0,
          height: 0,
          fps: 0,
          sizeBytes: 0,
          hasAudio: true
        }
      ]
    }
  })

  return {
    url,
    title: entries[0].title,
    extractor: 'page',
    mode: 'list',
    entries
  }
}

/**
 * Reads a page by hand and lists the streams it holds.
 *
 * This is the way out for a page the extractor does not understand: the
 * page is read, and every stream in it is offered as a video of its own.
 */
export async function scanPageAsList(url: string): Promise<VideoList> {
  const scan = await scanPage(url)
  if (scan.streams.length === 0) {
    throw new Error(
      scan.error
        ? `页面也没读到（${scan.error}）`
        : '页面里没有找到媒体地址'
    )
  }
  return scannedAsList(url, scan.streams, shortHash(url))
}

/**
 * Reads the renditions of one entry of a list.
 *
 * The list itself says what is on the page; the qualities of a single
 * video are read when they are wanted.
 */
export async function loadEntry(
  url: string,
  playlistItem?: number
): Promise<VideoEntry> {
  const args = ['--dump-single-json', '--no-warnings']
  if (playlistItem && playlistItem > 0) {
    args.push('--playlist-items', String(playlistItem))
  } else {
    args.push('--no-playlist')
  }
  args.push(url)

  const json = await parseJson(args)
  const picked = pickEntry(json, playlistItem)
  return entryFrom(picked, playlistItem ?? 1, shortHash(url))
}

/** Takes the entry that was asked for out of an answer. */
function pickEntry(json: YtdlpJson, playlistItem?: number): YtdlpJson {
  const entries = json.entries
  if (!entries || entries.length === 0) return json
  if (playlistItem && playlistItem >= 1 && playlistItem <= entries.length) {
    return entries[playlistItem - 1]
  }
  return entries[0]
}

/**
 * A short mark of a link.
 *
 * The entries of a page are numbered, and two pages can number their
 * entries the same way. The mark keeps the keys of two different links
 * apart, so one does not inherit the state of the other.
 */
function shortHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

function entryFrom(json: YtdlpJson, index: number, prefix: string): VideoEntry {
  const raw = collectFormats(json)
  return {
    index,
    id: `${prefix}_${index}_${json.id ?? json.format_id ?? ''}`,
    title: json.title ?? `第 ${index} 个视频`,
    duration: json.duration ?? 0,
    thumbnail: json.thumbnail,
    formats: raw.map(toFormatOption),
    choices: buildChoices(raw)
  }
}

/** Every stream the answer names, audio-only ones included. */
function collectFormats(json: YtdlpJson): RawFormat[] {
  const out: RawFormat[] = []
  const seen = new Set<string>()

  const push = (f: YtdlpFormat): void => {
    const id = f.format_id ?? ''
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push({ ...f, id })
  }

  for (const f of json.formats ?? []) push(f)

  // A site that offers one rendition reports it at the top level.
  if (out.length === 0 && json.format_id) {
    push({
      format_id: json.format_id,
      ext: json.ext,
      width: json.width,
      height: json.height,
      fps: json.fps,
      filesize: json.filesize,
      vcodec: 'h264',
      acodec: 'aac'
    })
  }

  return out
}

function toFormatOption(f: RawFormat): VideoFormatOption {
  return {
    id: f.id,
    label: formatLabel(f),
    ext: f.ext ?? 'mp4',
    width: f.width ?? 0,
    height: f.height ?? 0,
    fps: f.fps ?? 0,
    sizeBytes: sizeOf(f),
    hasAudio: hasAudioStream(f),
    vcodec: f.vcodec ?? '',
    acodec: f.acodec ?? '',
    bitrate: f.tbr ?? f.vbr ?? f.abr ?? 0
  }
}

function hasAudioStream(f: RawFormat): boolean {
  return !!f.acodec && f.acodec !== 'none'
}

function sizeOf(f: RawFormat): number {
  return f.filesize ?? f.filesize_approx ?? 0
}

function formatLabel(f: RawFormat): string {
  const height = f.height ?? 0
  const size = height ? `${height}p` : (f.format_note ?? f.ext ?? 'video')
  const fps = f.fps && Math.round(f.fps) > 30 ? `${Math.round(f.fps)}fps` : ''
  return [size, fps].filter(Boolean).join(' ')
}

/* ------------------------------------------------------------------ */
/* The qualities on offer                                              */
/* ------------------------------------------------------------------ */

/**
 * The codecs an editor is happiest with, best first.
 *
 * When a site offers the same picture in several codecs, the one that is
 * easiest to work with wins: H.264 first, then H.265, then the rest.
 */
const CODEC_ORDER = ['avc1', 'h264', 'hvc1', 'hevc', 'vp9', 'vp09', 'av01']

function codecRank(codec: string): number {
  const c = (codec ?? '').toLowerCase()
  const at = CODEC_ORDER.findIndex((x) => c.startsWith(x))
  return at === -1 ? CODEC_ORDER.length : at
}

/** The container family a stream belongs to. */
function family(ext?: string): string {
  const e = (ext ?? '').toLowerCase()
  if (['m4a', 'mp4', 'm4v', 'mov'].includes(e)) return 'mp4'
  if (['webm', 'weba'].includes(e)) return 'webm'
  if (['opus', 'ogg', 'oga'].includes(e)) return 'opus'
  return e
}

/**
 * The sound that goes with a picture.
 *
 * The sound has to live in a container the picture can hold, so the
 * streams of the same family are preferred. An MP4 picture takes an M4A
 * sound; a WebM picture takes an Opus one.
 */
function pickAudio(audios: RawFormat[], videoExt: string): RawFormat | null {
  if (audios.length === 0) return null
  const want = videoExt ? family(videoExt) : 'mp4'
  const same = audios.filter((a) => family(a.ext) === want)
  const pool = same.length > 0 ? same : audios
  return pool
    .slice()
    .sort((a, b) => {
      const bit = (a.abr ?? a.tbr ?? 0) - (b.abr ?? b.tbr ?? 0)
      if (bit !== 0) return bit > 0 ? -1 : 1
      return sizeOf(b) - sizeOf(a)
    })[0]
}

/** Which of two pictures of the same height is the better one. */
function betterVideo(a: RawFormat, b: RawFormat): boolean {
  const codec = codecRank(a.vcodec ?? '') - codecRank(b.vcodec ?? '')
  if (codec !== 0) return codec < 0
  const fps = (a.fps ?? 0) - (b.fps ?? 0)
  if (fps !== 0) return fps > 0
  return sizeOf(a) > sizeOf(b)
}

/**
 * The qualities a person picks from.
 *
 * The picture and the sound of a site often live in two separate streams.
 * Every picture therefore gets a quality that carries the sound as well,
 * and the stream on its own is offered next to it for the times when that
 * is what is wanted.
 */
function buildChoices(raw: RawFormat[]): VideoChoice[] {
  const videos = raw.filter((f) => f.vcodec && f.vcodec !== 'none')
  const audios = raw.filter(
    (f) => (!f.vcodec || f.vcodec === 'none') && hasAudioStream(f)
  )
  const choices: VideoChoice[] = []

  // One stream per height: the best of the codecs on offer.
  const byHeight = new Map<number, RawFormat>()
  for (const v of videos) {
    const height = v.height ?? 0
    const held = byHeight.get(height)
    if (!held || betterVideo(v, held)) byHeight.set(height, v)
  }

  for (const height of [...byHeight.keys()].sort((a, b) => b - a)) {
    const video = byHeight.get(height)
    if (!video) continue
    const audio = pickAudio(audios, video.ext ?? '')
    const label = height ? `${height}p` : (video.format_note ?? video.ext ?? '视频')

    if (audio) {
      choices.push({
        id: `${video.id}+${audio.id}`,
        label: `${label} · 有声`,
        ext: video.ext ?? 'mp4',
        width: video.width ?? 0,
        height,
        fps: video.fps ?? 0,
        sizeBytes: sizeOf(video) + sizeOf(audio),
        hasAudio: true
      })
    }

    choices.push({
      id: video.id,
      label: `${label} · ${hasAudioStream(video) ? '原始' : '无声'}`,
      ext: video.ext ?? 'mp4',
      width: video.width ?? 0,
      height,
      fps: video.fps ?? 0,
      sizeBytes: sizeOf(video),
      hasAudio: hasAudioStream(video)
    })
  }

  const only = pickAudio(audios, '')
  if (only) {
    choices.push({
      id: only.id,
      label: '仅音频',
      ext: only.ext ?? 'm4a',
      width: 0,
      height: 0,
      fps: 0,
      sizeBytes: sizeOf(only),
      hasAudio: true
    })
  }

  return choices
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Makes a name that can be written on every system.
 *
 * The titles the sites hand out carry characters that Windows refuses: a
 * colon, a question mark, a slash. The name is also shortened so that the
 * whole path stays inside the limit of the file system.
 */
export function sanitizeFileName(name: string): string {
  let out = name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // A name that ends in a dot or a space cannot be created on Windows.
    .replace(/[. ]+$/g, '')
    .trim()

  // The device names cannot be used as a file name.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = `_${out}`

  // Keep the name short enough for every file system.
  const limit = 120
  const points = Array.from(out)
  while (points.length > 0 && Buffer.byteLength(points.join(''), 'utf8') > limit) {
    points.pop()
  }

  return points.join('').trim() || 'video'
}

/* ------------------------------------------------------------------ */
/* Why a download failed                                               */
/* ------------------------------------------------------------------ */

/**
 * Says what went wrong in terms a person can act on.
 *
 * The words yt-dlp prints are meant for somebody who knows it. A site
 * that asks for a login, a copy of yt-dlp that is too old and a broken
 * connection need three different answers, and only one of them is worth
 * trying again.
 */
export function classifyFailure(stderr: string, message = ''): DownloadFailure {
  const text = `${stderr}\n${message}`

  // A page that cannot be reached is the reason for everything that comes
  // after it: the extractor says "unsupported" because it never saw the
  // page.
  if (/could not resolve|name or service not known|nodename nor servname|getaddrinfo|name resolution|域名解析不了/i.test(text)) {
    return {
      reason: 'dns',
      hint:
        '域名解析不了。浏览器可能用的是加密 DNS（DoH），而 yt-dlp 用的是系统 DNS——' +
        '换个网络或改一下 DNS 试试。'
    }
  }
  if (/timed out|timeout|connection reset|connection aborted|connection refused|network is unreachable|read timeout|EOF occurred/i.test(text)) {
    return { reason: 'network', hint: '网络断了，过一会儿再试。' }
  }

  if (/unsupported url|is not a supported url/i.test(text)) {
    return {
      reason: 'unsupported',
      hint:
        '这个链接里没找到可下的东西：yt-dlp 不认识它，页面里也没扫到媒体地址。' +
        '如果这是个播放器页面，多半要等站点更新或换个链接。'
    }
  }
  if (/sign in|login required|private video|this video is private|members[- ]only|age[- ]restricted|confirm your age|cookies|account/i.test(text)) {
    return {
      reason: 'auth',
      hint: '这个视频需要登录。在设置里选一个浏览器，用它的登录状态再试。'
    }
  }
  if (/requested format is not available|no video formats found|requested format not available/i.test(text)) {
    return {
      reason: 'format',
      hint: '这个画质已经没有了，换一个画质再试。'
    }
  }
  if (/nsig|unable to extract|failed to extract|signature extraction|http error 403|403 forbidden|429 too many requests/i.test(text)) {
    return {
      reason: 'outdated',
      hint: '多半是 yt-dlp 版本太旧了，更新一下再试。'
    }
  }
  if (/ffmpeg|ffprobe/i.test(text) && /not found|not installed|no such file/i.test(text)) {
    return {
      reason: 'ffmpeg',
      hint: '缺少 ffmpeg，画面和声音合不到一起。装好 ffmpeg 或设置 CLIPFORGE_FFMPEG。'
    }
  }
  if (/no space left|disk full|enospc/i.test(text)) {
    return { reason: 'disk', hint: '磁盘空间不够了。' }
  }

  return { reason: 'unknown', hint: message || '下载失败了。' }
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

    const fileName = sanitizeFileName(options.fileName || '')
    const args = [
      '--no-warnings',
      '--newline',
      '--progress',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--print',
      'after_move:filepath',
      // A finished file is never written over, and a half written one is
      // picked up where it was left.
      '--no-overwrites',
      '--continue'
    ]

    // A page with several videos: only the one that was picked.
    if (options.playlistItem && options.playlistItem > 0) {
      args.push('--playlist-items', String(options.playlistItem))
    } else {
      args.push('--no-playlist')
    }

    if (options.formatId) args.push('-f', options.formatId)

    // Some servers only hand the stream to a page that is named as the
    // one it came from.
    if (options.referer) args.push('--referer', options.referer)

    // The login of the browser, when the site wants one.
    if (options.cookiesFromBrowser) {
      args.push('--cookies-from-browser', options.cookiesFromBrowser)
    }
    if (options.cookiesFile) {
      args.push('--cookies', options.cookiesFile)
    }

    // The subtitles, when they are wanted. Putting them into the file
    // itself is ffmpeg's work.
    if (options.subtitles && options.subLangs) {
      args.push('--write-subs', '--sub-langs', options.subLangs)
      if (ffmpegPath()) args.push('--embed-subs')
    }

    // Putting a picture and a sound together is ffmpeg's work, and ffmpeg
    // is not necessarily on the path yt-dlp looks at.
    if (options.formatId?.includes('+')) {
      const ffmpeg = ffmpegPath()
      if (ffmpeg) args.push('--ffmpeg-location', dirname(ffmpeg))
    }

    const template = fileName ? `${fileName}.%(ext)s` : '%(title)s.%(ext)s'
    args.push('-o', join(options.outputDir, template))
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

    // A picture and a sound are two files: the bar has to account for both.
    const streamCount = options.formatId?.includes('+') ? 2 : 1
    let streamIndex = 0
    let lastPercent = 0

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
          // The next stream starts over from zero.
          if (progress.progress < lastPercent - 0.02 && streamIndex < streamCount - 1) {
            streamIndex += 1
            progress.progress = 0
            lastPercent = 0
          }
          lastPercent = progress.progress
          const overall =
            streamCount > 1
              ? (streamIndex + progress.progress) / streamCount
              : progress.progress
          this.emit('state', {
            status: 'running',
            message:
              streamCount > 1
                ? `正在下载${streamIndex === 0 ? '画面' : '声音'} ${(progress.progress * 100).toFixed(0)}%`
                : `正在下载 ${(overall * 100).toFixed(0)}%`,
            progress: { ...progress, progress: overall }
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
          const path = outputPath || findOutput(options, fileName)
          progress.progress = 1
          this.emit('state', {
            status: 'done',
            message: '下载完成',
            progress: { ...progress, progress: 1 },
            outputPath: path
          })
          resolve()
          return
        }
        const message = cleanError(stderrTail) || `yt-dlp exited with code ${code}`
        this.emit('state', {
          status: 'error',
          message,
          progress: { ...progress },
          failure: classifyFailure(stderrTail, message)
        })
        reject(new Error(message))
      })
    })
  }
}

/**
 * Finds the file a finished download wrote.
 *
 * yt-dlp prints the path, but it only prints it when the file is already
 * there. When it does not, the name is known and the directory is known,
 * so the file can be looked for.
 */
function findOutput(options: DownloadOptions, fileName: string): string {
  if (!fileName) return ''
  const expected = options.outputExt
    ? join(options.outputDir, `${fileName}.${options.outputExt}`)
    : ''
  if (expected && existsSync(expected)) return expected

  try {
    const names = readdirSync(options.outputDir)
    const hits = names.filter((n) => n.startsWith(`${fileName}.`) || n === fileName)
    let newest = ''
    let newestTime = 0
    for (const hit of hits) {
      const full = join(options.outputDir, hit)
      try {
        const time = statSync(full).mtimeMs
        if (time > newestTime) {
          newestTime = time
          newest = full
        }
      } catch {
        /* the file went away */
      }
    }
    return newest
  } catch {
    return ''
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
