import { spawn } from 'child_process'
import { statSync } from 'fs'
import { basename } from 'path'
import { ffprobePath } from '../ffmpeg'
import type { AssetKind, ProbeResult } from '@shared/types'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { duration?: string; size?: string; format_name?: string }
}

function parseRate(rate?: string): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!den || !num) return 0
  const v = num / den
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : 0
}

/** Reads container/stream metadata for a media file. */
export async function probeFile(path: string): Promise<ProbeResult> {
  const ffprobe = ffprobePath()
  if (!ffprobe) throw new Error('ffprobe not found — install FFmpeg or set CLIPFORGE_FFPROBE')

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path
    ])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`ffprobe failed (${code}): ${err.slice(0, 400)}`))
    })
  })

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(raw) as FfprobeOutput
  } catch {
    throw new Error('ffprobe returned malformed output')
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  const formatDuration = Number(parsed.format?.duration ?? 0)
  const videoDuration = Number(video?.duration ?? 0)
  const audioDuration = Number(audio?.duration ?? 0)
  const duration = pickDuration(formatDuration, videoDuration, audioDuration)

  const fps = parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate) || 0

  let kind: AssetKind = 'video'
  if (!video && audio) kind = 'audio'

  // A still picture is recognised by its file extension, not by its
  // duration: ffprobe reports a JPEG as a one-frame video of 0.04s at
  // 25fps, so a duration test would call it a video. Only the extension
  // tells a picture from a recording.
  if (kind === 'video' && video && !audio && STILL_EXTENSIONS.has(extensionOf(path))) {
    kind = 'image'
  }

  let sizeBytes = 0
  try {
    sizeBytes = statSync(path).size
  } catch {
    sizeBytes = Number(parsed.format?.size ?? 0)
  }

  return {
    path,
    name: basename(path),
    kind,
    // A picture has no length of its own — it stays on the timeline for
    // as long as the clip says.
    duration: kind === 'image' ? 0 : Math.max(0, duration),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasAudio: !!audio,
    codec: video?.codec_name ?? audio?.codec_name ?? 'unknown',
    sizeBytes
  }
}

/** The file extensions that hold a single still picture. */
const STILL_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'webp',
  'bmp',
  'gif',
  'tif',
  'tiff',
  'avif'
])

/** The lower-case extension of a path, without the dot. */
function extensionOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  const name = filePath.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function pickDuration(...values: number[]): number {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0)
  return valid.length ? Math.max(...valid) : 0
}
