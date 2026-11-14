import { spawn } from 'child_process'
import { ffmpegPath } from '../ffmpeg'

/**
 * Audio peak extraction.
 *
 * We pipe decoded mono PCM straight out of FFmpeg and reduce it to peak
 * envelopes on the fly — holding a 10-minute stereo file in memory would cost
 * hundreds of megabytes, whereas the peak envelope is a few hundred kilobytes
 * and is all the timeline needs to draw a waveform.
 */

const SAMPLE_RATE = 8000
const BUCKETS_PER_SECOND = 200

export interface WaveformResult {
  peaks: Float32Array
  buckets: number
}

export async function extractWaveform(path: string, duration: number): Promise<WaveformResult> {
  const ffmpeg = ffmpegPath()
  if (!ffmpeg) throw new Error('ffmpeg not found — install FFmpeg or set CLIPFORGE_FFMPEG')

  const totalSamples = Math.max(1, Math.ceil(duration * SAMPLE_RATE))
  const totalBuckets = Math.max(1, Math.min(Math.ceil(duration * BUCKETS_PER_SECOND), 400_000))
  const samplesPerBucket = Math.max(1, Math.floor(totalSamples / totalBuckets))

  const peaks = new Float32Array(totalBuckets)
  let bucket = 0
  let inBucket = 0
  let peak = 0
  let samples = 0
  let overflow = false

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', path,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 'f32le',
      '-'
    ])

    child.stdout.on('data', (chunk: Buffer) => {
      // Float32 samples are 4 bytes; keep a remainder across chunk edges.
      let offset = 0
      const usable = chunk.length - (chunk.length % 4)
      for (; offset < usable; offset += 4) {
        const v = chunk.readFloatLE(offset)
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
        inBucket++
        samples++
        if (inBucket >= samplesPerBucket) {
          if (bucket < totalBuckets) peaks[bucket] = peak
          bucket++
          inBucket = 0
          peak = 0
        }
      }
    })

    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      // Flush the trailing partial bucket.
      if (inBucket > 0 && bucket < totalBuckets) peaks[bucket] = peak
      if (code !== 0 && !overflow) {
        // A file without an audio stream exits non-zero — that is not fatal,
        // it simply yields a flat waveform.
        if (!/does not contain any stream|Output file #0 does not contain/i.test(stderr)) {
          reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(0, 400)}`))
          return
        }
      }
      resolve()
    })
  })

  // Normalise so quiet recordings still read clearly, guarding against silence.
  let max = 0
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i]
  if (max > 0 && max < 0.05) {
    const gain = 0.9 / max
    for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, peaks[i] * gain)
  } else if (max > 1) {
    for (let i = 0; i < peaks.length; i++) peaks[i] /= max
  }

  return { peaks, buckets: BUCKETS_PER_SECOND }
}
