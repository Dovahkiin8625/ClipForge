import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { ffmpegPath } from '../ffmpeg'
import { toMediaUrl } from '../protocol'
import type { SpriteSheet } from '@shared/types'

/**
 * Thumbnail generation.
 *
 * The timeline draws a filmstrip of real frames inside every clip. Rather
 * than shelling out to FFmpeg per thumbnail (≈100 ms each, far too slow while
 * scrolling) we bake a *sprite sheet* — a grid of frames — once per asset and
 * blit from it.
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
  const interval = span / count

  const key = createHash('sha1')
    .update(
      `${req.path}|${startTime.toFixed(3)}|${endTime.toFixed(3)}|${columns}|${rows}|${frameWidth}|${still ? 'still' : 'clip'}`
    )
    .digest('hex')
    .slice(0, 20)
  const outPath = join(cacheDir(), `${key}.jpg`)

  if (!existsSync(outPath)) {
    const args = still
      ? // A still is scaled on its own. Seeking into it or running it through
        // the `fps` filter makes FFmpeg write an empty file, so neither is
        // done here.
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', req.path,
          '-vf', `scale=${frameWidth}:-2:flags=bilinear`,
          '-frames:v', '1',
          '-q:v', '4',
          '-y', outPath
        ]
      : [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', startTime.toFixed(4),
        '-t', span.toFixed(4),
        '-i', req.path,
        '-vf',
        `fps=${interval > 0 ? (1 / interval).toFixed(6) : '1'},scale=${frameWidth}:-2:flags=bilinear,tile=${columns}x${rows}`,
        '-frames:v', '1',
        '-q:v', '4',
        '-y', outPath
      ]
    await runFfmpeg(ffmpeg, args)
  }

  // The tile filter emits only as many rows as the input actually filled, so
  // the real geometry has to be read back from the file.
  const dims = await probeImage(outPath)
  const srcW = req.sourceWidth ?? 0
  const srcH = req.sourceHeight ?? 0
  const expectedFrameH =
    srcW > 0 && srcH > 0
      ? Math.max(2, Math.round((frameWidth * srcH) / srcW / 2) * 2)
      : frameWidth

  const actualRows =
    dims.height > 0 ? Math.max(1, Math.round(dims.height / expectedFrameH)) : rows
  const frameHeight =
    dims.height > 0 ? Math.round(dims.height / actualRows) : expectedFrameH

  return {
    path: outPath,
    url: toMediaUrl(outPath),
    cols: columns,
    rows: actualRows,
    count: columns * actualRows,
    frameWidth: dims.width > 0 ? Math.round(dims.width / columns) : frameWidth,
    frameHeight,
    startTime: still ? 0 : startTime,
    // A still has no time axis; a non-zero interval keeps the maths in the
    // timeline from dividing by zero.
    interval: still ? 1 : interval
  }
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
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
