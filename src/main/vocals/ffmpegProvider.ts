import { spawn } from 'child_process'
import { join } from 'path'
import { ffmpegPath } from '../ffmpeg'
import { probeFile } from '../media/probe'
import type { VocalServiceModel } from '@shared/vocals'
import type { VocalProvider, VocalProviderContext } from './provider'

/**
 * Lifts the voice out of a recording without a model.
 *
 * A voice is usually mixed in the middle of the stereo field, so the middle
 * channel — the average of left and right — holds most of it. Averaging is
 * what this filter does: whatever is common to both sides survives, whatever
 * sits at the edges is cancelled out.
 *
 * It is fast, free and needs nothing but FFmpeg, but it is an approximation:
 * a voice panned to one side is lost, and so is anything else in the middle.
 * The neural network behind the separation service does far better; this is
 * the fallback that keeps the feature working without it.
 */
export class FfmpegVocalProvider implements VocalProvider {
  readonly id = 'ffmpeg-center'
  readonly label = 'FFmpeg 中置声道提取'
  readonly kind = 'filter' as const

  async models(): Promise<VocalServiceModel[]> {
    return []
  }

  async available(): Promise<{ available: boolean; reason?: string }> {
    if (!ffmpegPath()) {
      return { available: false, reason: '未找到 FFmpeg' }
    }
    return { available: true }
  }

  async separate(
    sourceWav: string,
    ctx: VocalProviderContext
  ): Promise<{ path: string; duration: number }> {
    const bin = ffmpegPath()
    if (!bin) throw new Error('未找到 FFmpeg，无法分离人声')

    const probe = await probeFile(sourceWav)
    const duration = probe.duration
    const output = join(ctx.workDir, 'vocals-center.wav')

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        bin,
        [
          '-hide_banner',
          '-nostdin',
          '-y',
          '-i', sourceWav,
          // The pan filter needs two channels to average; a mono source is
          // spread across both first.
          '-af', 'aformat=channel_layouts=stereo,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1',
          '-c:a', 'pcm_s16le',
          '-progress', 'pipe:1',
          '-nostats',
          output
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const eq = line.indexOf('=')
          if (eq < 0) continue
          if (line.slice(0, eq).trim() !== 'out_time_us') continue
          const micros = Number(line.slice(eq + 1).trim())
          if (!Number.isFinite(micros) || duration <= 0) continue
          ctx.report(Math.min(1, micros / 1_000_000 / duration), '正在提取中置声道…')
        }
      })

      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000)
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          ctx.report(1, '中置声道提取完成')
          resolve()
        } else {
          reject(new Error(extractError(stderr) || `FFmpeg 退出码 ${code}`))
        }
      })
    })

    const result = await probeFile(output)
    return { path: output, duration: result.duration || duration }
  }
}

function extractError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .filter((l) => /error|invalid|unable|failed|no such/i.test(l))
  return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
}
