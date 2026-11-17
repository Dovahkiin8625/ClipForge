import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { ffmpegPath, ffprobePath } from '../ffmpeg'
import { toMediaUrl } from '../protocol'
import { probeFile } from './probe'
import type { SpriteSheet } from '@shared/types'

/**
 * Thumbnail generation.
 *
 * The timeline draws a filmstrip of real frames inside every clip. Rather
 * than shelling out to FFmpeg per thumbnail (≈100 ms each, far too slow while
 * scrolling) we bake a *sprite sheet* — a grid of frames — once per asset and
 * blit from it.
 *
 * The sheet is baked from the *key frames* of the movie. Decoding a whole
 * video to pick sixty frames out of it is the slow way to draw a filmstrip:
 * the decoder has to rebuild every single frame of the film, and on a long
 * recording that takes many seconds. The key frames alone are enough for a
 * thumbnail strip, and FFmpeg can be told to decode only those
 * (`-skip_frame nokey`) — which turns a full decode into a read of the file
 * plus a few hundred frame rebuilds.
 *
 * When the user zooms in far enough that the sheet is too coarse, we bake a
 * second, denser sheet covering just the visible window. Sheets are cached on
 * disk by content hash so a project re-opens instantly.
 */

const cacheDir = (): string => {
  const dir = join(app.getPath('userData'), 'cache', 'sprites')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface SpriteRequest {
  path: string
  startTime: number
  endTime: number
  columns: number
  /** Pixel width of one frame in the sheet. */
  frameWidth?: number
  rows?: number
  /** Source dimensions, used to work out the real frame height. */
  sourceWidth?: number
  sourceHeight?: number
  /**
   * The file is a single still picture rather than a recording.
   *
   * A still is not a video that happens to be short: the image demuxer gives
   * it a duration of a fraction of a second, and FFmpeg's `fps` and `tile`
   * filters then produce an *empty* sheet for it. A still is therefore
   * scaled on its own, without seeking or filtering.
   */
  still?: boolean
}

export interface Poster {
  /** Absolute path to the generated picture on disk. */
  path: string
  /** `clipforge://` URL the renderer can load into an <img>. */
  url: string
}

/**
 * Where the frames of a sheet really are.
 *
 * The frames are picked from the key frames of the film, so they do not
 * necessarily sit at even intervals. The note beside the sheet keeps the
 * truth about them, so that a sheet that was baked earlier is read the same
 * way as one that was baked just now.
 */
interface SheetMeta {
  /** How many rows of frames the sheet holds. */
  rows: number
  /** Source-time of the first frame. */
  startTime: number
  /** Source-time between two frames. */
  interval: number
}

export async function buildSprite(req: SpriteRequest): Promise<SpriteSheet> {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('ffmpeg not found — install FFmpeg or set CLIPFORGE_FFMPEG')

  const still = req.still === true
  const columns = still ? 1 : Math.max(1, Math.min(20, Math.round(req.columns)))
  const frameWidth = req.frameWidth ?? 160
  const rows = still ? 1 : (req.rows ?? 6)
  const startTime = Math.max(0, req.startTime)
  const endTime = Math.max(startTime + 0.05, req.endTime)
  const span = endTime - startTime
  const count = columns * rows

  const key = createHash('sha1')
    .update(
      // The version keeps sheets that were baked by an older, slower recipe
      // from being picked up again.
      `v2|${req.path}|${startTime.toFixed(3)}|${endTime.toFixed(3)}|${columns}|${rows}|${frameWidth}|${still ? 'still' : 'clip'}`
    )
    .digest('hex')
    .slice(0, 20)
  const outPath = join(cacheDir(), `${key}.jpg`)
  const metaPath = `${outPath}.json`

  // The shape of the source decides how tall a frame of the sheet is; the
  // caller usually knows it already.
  const source = await sourceSize(req)
  const frameHeight =
    source.width > 0 && source.height > 0
      ? Math.max(2, Math.round((frameWidth * source.height) / source.width / 2) * 2)
      : frameWidth

  let meta = await readMeta(metaPath)

  if (!existsSync(outPath)) {
    if (still) {
      await runFfmpeg(ffmpeg, stillArgs(req.path, frameWidth, outPath))
    } else {
      // The quick way reads the key frames only; the slow way decodes the
      // whole film. The quick one is tried first and the slow one is the
      // fallback for files FFmpeg cannot serve that way.
      const built = await buildFromKeyframes(ffmpeg, {
        path: req.path,
        outPath,
        columns,
        rows,
        frameWidth,
        startTime,
        endTime,
        span
      })
      if (built && (await sheetIsFull(outPath, built.rows, frameHeight))) {
        meta = built
      } else {
        // A sheet that is not full means the decoder and FFprobe did not
        // agree on the key frames of the file.
        if (built) removeFile(outPath)
        await runFfmpeg(
          ffmpeg,
          fullDecodeArgs({
            path: req.path,
            outPath,
            columns,
            rows,
            frameWidth,
            startTime,
            span,
            interval: span / count
          })
        )
      }
    }
  }

  // The tile filter emits only as many rows as the input actually filled, so
  // the real geometry has to be read back from the file.
  const dims = await probeImage(outPath)
  const actualRows =
    meta?.rows ??
    (dims.height > 0 ? Math.max(1, Math.round(dims.height / frameHeight)) : rows)
  const realFrameHeight = dims.height > 0 ? Math.round(dims.height / actualRows) : frameHeight
  const actualCount = columns * actualRows
  const sheetStart = still ? 0 : (meta?.startTime ?? startTime)
  // A still has no time axis; a non-zero interval keeps the maths in the
  // timeline from dividing by zero.
  const sheetInterval = still ? 1 : (meta?.interval ?? span / actualCount)

  if (!meta) {
    await writeMeta(metaPath, {
      rows: actualRows,
      startTime: sheetStart,
      interval: sheetInterval
    })
  }

  return {
    path: outPath,
    url: toMediaUrl(outPath),
    cols: columns,
    rows: actualRows,
    count: actualCount,
    frameWidth: dims.width > 0 ? Math.round(dims.width / columns) : frameWidth,
    frameHeight: realFrameHeight,
    startTime: sheetStart,
    interval: sheetInterval
  }
}

/**
 * A single picture of a recording, for the card in the library.
 *
 * The sheet holds dozens of frames and takes a moment to bake; the card shows
 * only one of them, so it gets a picture of its own — one seek, one frame, no
 * grid. It shows up long before the filmstrip does.
 */
export async function buildPoster(
  path: string,
  time: number,
  frameWidth = 320
): Promise<Poster | null> {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('ffmpeg not found — install FFmpeg or set CLIPFORGE_FFMPEG')

  const at = Math.max(0, time)
  const key = createHash('sha1')
    .update(`poster|${path}|${at.toFixed(3)}|${frameWidth}`)
    .digest('hex')
    .slice(0, 20)
  const outPath = join(cacheDir(), `poster-${key}.jpg`)

  if (!existsSync(outPath)) {
    try {
      await runFfmpeg(ffmpeg, [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', at.toFixed(3),
        '-i', path,
        '-frames:v', '1',
        '-vf', `scale=${frameWidth}:-2:flags=bilinear`,
        '-q:v', '4',
        '-y', outPath
      ])
    } catch {
      // A file that cannot give up a frame simply has no picture.
      return null
    }
  }

  return { path: outPath, url: toMediaUrl(outPath) }
}

/* ------------------------------------------------------------------ */
/* Building the sheet                                                   */
/* ------------------------------------------------------------------ */

interface SheetOptions {
  path: string
  outPath: string
  columns: number
  rows: number
  frameWidth: number
  startTime: number
  endTime: number
  span: number
}

/**
 * Bakes the sheet out of the key frames of the film.
 *
 * Returns null when the file cannot be served this way — too few key frames,
 * or a codec FFmpeg will not skip frames for — and the caller falls back to
 * the slow path.
 */
async function buildFromKeyframes(
  ffmpeg: string,
  opts: SheetOptions
): Promise<SheetMeta | null> {
  const keyframes = await listKeyframeTimes(opts.path)
  if (keyframes.length === 0) return null

  // Only the key frames inside the window can be used.
  const inside = keyframes
    .map((time, ordinal) => ({ time, ordinal }))
    .filter((k) => k.time >= opts.startTime - 0.001 && k.time <= opts.endTime + 0.001)
  if (inside.length < opts.columns) return null

  // The grid shrinks when the film has too few key frames to fill it: a
  // sheet that is only half full would show blank cells in the timeline.
  const rows = Math.min(opts.rows, Math.floor(inside.length / opts.columns))
  if (rows < 1) return null
  const count = opts.columns * rows
  const interval = opts.span / count

  // Every cell of the grid is given the key frame closest to the start of
  // the stretch it covers — which is how the timeline reads a frame out of
  // the sheet.
  const targets: number[] = []
  for (let i = 0; i < count; i++) targets.push(opts.startTime + i * interval)

  const picked = pickKeyframes(
    inside.map((k) => k.time),
    targets
  )
  if (picked.length !== count) return null

  // The ordinals count the key frames of the whole file, so the filter has
  // to see all of them — the file is read from the start either way.
  const expression = picked
    .map((index) => `eq(n\\,${inside[index].ordinal})`)
    .join('+')

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // Only the key frames are decoded; the rest of the film is skipped.
    '-skip_frame', 'nokey',
    '-i', opts.path,
    '-vf',
    `select='${expression}',scale=${opts.frameWidth}:-2:flags=bilinear,tile=${opts.columns}x${rows}`,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', opts.outPath
  ]

  try {
    await runFfmpeg(ffmpeg, args)
  } catch {
    // A half-written file would be read as a finished sheet later on.
    removeFile(opts.outPath)
    return null
  }

  // The frames sit where the key frames are, which is not always an even
  // distance apart. The timeline needs to know where they really are.
  const first = inside[picked[0]].time
  const last = inside[picked[picked.length - 1]].time
  const realInterval = count > 1 ? (last - first) / (count - 1) : interval

  return {
    rows,
    startTime: first,
    interval: realInterval > 0 ? realInterval : interval
  }
}

/** The arguments that decode the whole film into a sheet. */
function fullDecodeArgs(opts: {
  path: string
  outPath: string
  columns: number
  rows: number
  frameWidth: number
  startTime: number
  span: number
  interval: number
}): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', opts.startTime.toFixed(4),
    '-t', opts.span.toFixed(4),
    '-i', opts.path,
    '-vf',
    `fps=${opts.interval > 0 ? (1 / opts.interval).toFixed(6) : '1'},scale=${opts.frameWidth}:-2:flags=bilinear,tile=${opts.columns}x${opts.rows}`,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', opts.outPath
  ]
}

/** The arguments that scale a still picture into a sheet of one. */
function stillArgs(path: string, frameWidth: number, outPath: string): string[] {
  // A still is scaled on its own. Seeking into it or running it through
  // the `fps` filter makes FFmpeg write an empty file, so neither is
  // done here.
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', path,
    '-vf', `scale=${frameWidth}:-2:flags=bilinear`,
    '-frames:v', '1',
    '-q:v', '4',
    '-y', outPath
  ]
}

/* ------------------------------------------------------------------ */
/* Key frames                                                           */
/* ------------------------------------------------------------------ */

/**
 * The times of the key frames of a file, in seconds.
 *
 * FFprobe can list them without rebuilding a single frame: `-skip_frame
 * nokey` makes the decoder drop every frame that is not a key frame, so the
 * file is only read. That is what makes the quick sheet possible.
 */
async function listKeyframeTimes(path: string): Promise<number[]> {
  const ffprobe = ffprobePath()
  if (!ffprobe) return []

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time',
      '-of', 'csv=p=0',
      path
    ])
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', () => undefined)
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ffprobe failed (${code})`))
    )
  })

  const times: number[] = []
  for (const line of raw.split(/\r?\n/)) {
    // The CSV writer leaves a stray comma on some lines.
    const match = line.match(/-?\d+(?:\.\d+)?/)
    if (!match) continue
    const value = Number(match[0])
    if (Number.isFinite(value)) times.push(value)
  }
  return times.sort((a, b) => a - b)
}

/**
 * Picks the key frame that shows each cell of the grid best.
 *
 * The cells are spread evenly over the window and every one of them is given
 * the key frame closest to it, so the strip shows the whole film instead of a
 * stretch of it.
 *
 * Each cell may only take the key frames of its own stretch of the file, and
 * those stretches do not overlap. Without that rule a cell could take the
 * frame that the next one needs, and the sheet would come up short.
 */
function pickKeyframes(times: number[], targets: number[]): number[] {
  const available = times.length
  const cells = targets.length
  if (cells === 0 || available < cells) return []

  // How many key frames apart two neighbouring cells lie.
  const step = cells > 1 ? (available - 1) / (cells - 1) : 0

  const picked: number[] = []
  let cursor = 0

  for (let i = 0; i < cells; i++) {
    const lo = cells > 1 ? Math.max(cursor, Math.floor(i * step - step / 2)) : cursor
    const hi = cells > 1 ? Math.min(available - 1, Math.ceil(i * step + step / 2)) : available - 1

    let best = -1
    let bestDistance = Infinity
    for (let k = lo; k <= hi; k++) {
      const distance = Math.abs(times[k] - targets[i])
      if (distance < bestDistance) {
        bestDistance = distance
        best = k
      }
    }

    if (best < 0) return []
    picked.push(best)
    cursor = best + 1
  }

  return picked
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/**
 * The size of the source.
 *
 * The aspect ratio of the source decides how tall a frame of the sheet is;
 * without it the rows of the grid cannot be counted, and the timeline would
 * read the wrong frames out of the sheet.
 */
async function sourceSize(req: SpriteRequest): Promise<{ width: number; height: number }> {
  if (req.sourceWidth && req.sourceHeight) {
    return { width: req.sourceWidth, height: req.sourceHeight }
  }
  try {
    const probe = await probeFile(req.path)
    return { width: probe.width, height: probe.height }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Whether the sheet holds every row it was asked for.
 *
 * The tile filter fills the grid only as far as the frames reach, so a short
 * sheet means that some of the frames were never decoded.
 */
async function sheetIsFull(
  path: string,
  rows: number,
  frameHeight: number
): Promise<boolean> {
  if (frameHeight <= 0) return true
  const dims = await probeImage(path)
  if (dims.height <= 0) return false
  return dims.height >= rows * frameHeight - 2
}

/** Removes a file that turned out to be unusable. */
function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Nothing to clean up.
  }
}

/** Reads the note that sits beside a baked sheet. */
async function readMeta(path: string): Promise<SheetMeta | null> {
  const { readFile } = await import('fs/promises')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<SheetMeta>
    if (
      typeof parsed.rows !== 'number' ||
      typeof parsed.startTime !== 'number' ||
      typeof parsed.interval !== 'number'
    ) {
      return null
    }
    return { rows: parsed.rows, startTime: parsed.startTime, interval: parsed.interval }
  } catch {
    return null
  }
}

/** Writes the note that sits beside a baked sheet. */
async function writeMeta(path: string, meta: SheetMeta): Promise<void> {
  const { writeFile } = await import('fs/promises')
  try {
    await writeFile(path, JSON.stringify(meta), 'utf8')
  } catch {
    // The note is a convenience; a sheet without one still works.
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 500)}`))
    })
  })
}

/** Reads width/height straight from the JPEG/PNG header — no image lib needed. */
async function probeImage(path: string): Promise<{ width: number; height: number }> {
  const { readFile } = await import('fs/promises')
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    return { width: 0, height: 0 }
  }

  // PNG
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // JPEG — walk the marker segments.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = buf[offset + 1]
      // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
      }
      const segmentLength = buf.readUInt16BE(offset + 2)
      offset += 2 + segmentLength
    }
  }
  return { width: 0, height: 0 }
}
