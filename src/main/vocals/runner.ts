import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { copyFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { ffmpegPath } from '../ffmpeg'
import { probeFile } from '../media/probe'
import { toMediaUrl } from '../protocol'
import type { VocalSeparateRequest, VocalSeparateResult, VocalState } from '@shared/vocals'
import { FfmpegVocalProvider } from './ffmpegProvider'
import type { VocalProvider, VocalProviderContext } from './provider'
import { ServiceVocalProvider } from './serviceProvider'
import { resolveServiceUrl, VocalServiceClient } from './serviceClient'

/**
 * Runs a vocal separation from start to finish.
 *
 * The runner owns the parts that every provider shares: cutting the clip out
 * of its source, handing the provider a WAV file, and putting the result
 * where the app can find it again. Which provider does the actual separating
 * is decided here — a model from the separation service when there is one,
 * the local filter otherwise.
 */
export class VocalRunner extends EventEmitter {
  private cancelled = false
  private running = false

  get busy(): boolean {
    return this.running
  }

  cancel(): void {
    this.cancelled = true
  }

  /** The providers that are available right now, best first. */
  async providers(): Promise<
    { id: string; label: string; kind: 'model' | 'filter'; available: boolean; reason?: string }[]
  > {
    const found: {
      id: string
      label: string
      kind: 'model' | 'filter'
      available: boolean
      reason?: string
    }[] = []

    const service = await this.serviceProviders()
    for (const provider of service) {
      found.push({
        id: provider.id,
        label: provider.label,
        kind: provider.kind,
        available: true
      })
    }

    const filter = new FfmpegVocalProvider()
    const state = await filter.available()
    found.push({ id: filter.id, label: filter.label, kind: filter.kind, ...state })

    return found
  }

  async run(request: VocalSeparateRequest): Promise<VocalSeparateResult> {
    if (this.running) throw new Error('已有人声分离任务正在进行')
    this.cancelled = false
    this.running = true

    const workDir = join(app.getPath('userData'), 'vocals', `work_${Date.now().toString(36)}`)
    mkdirSync(workDir, { recursive: true })

    try {
      const provider = await this.pickProvider(request)
      this.emit('state', stateOf('running', 0, '正在准备素材…', provider))

      const ctx: VocalProviderContext = {
        report: (progress, message) => {
          this.emit('state', stateOf('running', progress, message, provider))
        },
        cancelled: () => this.cancelled,
        workDir
      }

      const sourceWav = await this.extractSource(request, workDir, ctx)

      const result = await provider.separate(sourceWav, ctx)

      const stored = await this.store(result.path, request.name ?? 'vocals')
      const probe = await probeFile(stored).catch(() => null)

      this.emit('state', stateOf('done', 1, '人声分离完成', provider))
      return {
        path: stored,
        url: toMediaUrl(stored),
        duration: result.duration || probe?.duration || 0,
        provider: provider.id,
        model: provider.modelId,
        label: provider.label
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('state', { status: 'error', progress: 0, message, error: message })
      throw err
    } finally {
      this.running = false
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  /**
   * Chooses the provider for a job.
   *
   * A model from the service wins over the local filter — it separates far
   * better — but the service is optional, so the filter is always there as a
   * fallback.
   */
  private async pickProvider(request: VocalSeparateRequest): Promise<VocalProvider> {
    const service = await this.serviceProviders()

    if (request.provider) {
      const chosen = service.find((p) => p.id === request.provider)
      if (chosen) return chosen
    }

    const model = service.find((p) => p.kind === 'model')
    if (model) return model

    const filter = new FfmpegVocalProvider()
    const state = await filter.available()
    if (!state.available) {
      throw new Error(state.reason ?? '没有可用的分离方式')
    }
    return filter
  }

  /** Asks the service what it can do, if it is there at all. */
  private async serviceProviders(): Promise<VocalProvider[]> {
    try {
      const url = await resolveServiceUrl()
      const client = new VocalServiceClient(url)
      const health = await client.health()
      if (health.status !== 'ok') return []
      return (health.providers ?? [])
        .filter((descriptor) => descriptor.available)
        .map((descriptor) => new ServiceVocalProvider(client, descriptor))
    } catch {
      // The service is optional. Its absence is not an error.
      return []
    }
  }

  /**
   * Cuts the clip's own audio out of the source file.
   *
   * The tempo follows the clip's speed, so the separated voice lines up with
   * the picture it was taken from.
   */
  private async extractSource(
    request: VocalSeparateRequest,
    workDir: string,
    ctx: VocalProviderContext
  ): Promise<string> {
    const bin = ffmpegPath()
    if (!bin) throw new Error('未找到 FFmpeg，无法分离人声')

    const source = request.sourcePath
    if (!existsSync(source)) throw new Error(`找不到源文件：${source}`)

    const speed = request.speed && request.speed > 0 ? request.speed : 1
    const duration = request.duration && request.duration > 0 ? request.duration : 0
    const output = join(workDir, 'source.wav')

    const args = ['-hide_banner', '-nostdin', '-y']
    if (request.start && request.start > 0) args.push('-ss', String(request.start))
    args.push('-i', source)
    if (duration > 0) args.push('-t', String(duration))
    args.push('-vn', '-ac', '2', '-ar', '44100')
    const tempo = atempoChain(speed)
    if (tempo) args.push('-af', tempo)
    args.push('-c:a', 'pcm_s16le', '-progress', 'pipe:1', '-nostats', output)

    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

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
          ctx.report(Math.min(0.2, (micros / 1_000_000 / duration) * 0.2), '正在裁切片段音频…')
        }
      })

      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000)
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else {
          const lines = stderr
            .split(/\r?\n/)
            .filter((l) => /error|invalid|unable|failed|no such/i.test(l))
          reject(new Error(lines[lines.length - 1]?.slice(0, 300) ?? `FFmpeg 退出码 ${code}`))
        }
      })
    })

    return output
  }

  /** Moves the result into the app's own storage, where it will survive. */
  private async store(source: string, name: string): Promise<string> {
    const dir = join(app.getPath('userData'), 'vocals')
    mkdirSync(dir, { recursive: true })
    const stamp = Date.now().toString(36)
    const target = join(dir, `${sanitise(name)}_${stamp}.wav`)
    await copyFileTo(source, target)
    return target
  }
}

/**
 * Builds an `atempo` chain for a playback rate.
 *
 * A single `atempo` filter only covers 0.5–2×, so faster rates are split
 * into several of them.
 */
export function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 0.001) return ''
  const parts: string[] = []
  let remaining = speed
  while (remaining > 2.0001) {
    parts.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.4999) {
    parts.push('atempo=0.5')
    remaining /= 0.5
  }
  if (Math.abs(remaining - 1) > 0.001) {
    parts.push(`atempo=${remaining.toFixed(4)}`)
  }
  return parts.join(',')
}

function sanitise(name: string): string {
  // The extension of the source file has no place in the name of the
  // result: "clip-a.mp4" becomes "clip-a".
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return stem.replace(/[^\w\-一-龥]+/g, '_').slice(0, 60) || 'vocals'
}

async function copyFileTo(from: string, to: string): Promise<void> {
  await copyFile(from, to)
}

function stateOf(
  status: VocalState['status'],
  progress: number,
  message: string,
  provider?: VocalProvider
): VocalState {
  return {
    status,
    progress,
    message,
    provider: provider?.id,
    model: provider?.modelId
  }
}
