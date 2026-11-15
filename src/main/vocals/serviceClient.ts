import { readFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import type {
  VocalJob,
  VocalServiceHealth,
  VocalServiceProvider
} from '@shared/vocals'

/**
 * The HTTP client for the separation service.
 *
 * The service is an ordinary program that happens to speak HTTP. ClipForge
 * never imports it, never embeds it and never requires it: when it is not
 * running, `health()` simply fails and the runner falls back to the local
 * filter.
 */

/** Where the service is expected to listen. */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8777'

/** Uploading and downloading audio may take a while on a slow link. */
const UPLOAD_TIMEOUT = 10 * 60 * 1000

/**
 * Resolves the address of the service.
 *
 * The environment variable wins, so a user can point the app at a service on
 * another machine without touching the settings file. The file in the app's
 * storage is written by the settings UI; when it is missing the default
 * address is used.
 */
export async function resolveServiceUrl(): Promise<string> {
  const fromEnv = process.env['CLIPFORGE_VOCAL_SERVICE']
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, '')

  try {
    const raw = await readFile(join(app.getPath('userData'), 'vocal-service.json'), 'utf8')
    const parsed = JSON.parse(raw) as { baseUrl?: string }
    if (parsed?.baseUrl && parsed.baseUrl.trim()) {
      return parsed.baseUrl.trim().replace(/\/+$/, '')
    }
  } catch {
    /* No settings file — the default address is as good as any. */
  }
  return DEFAULT_SERVICE_URL
}

export class VocalServiceError extends Error {}

export class VocalServiceClient {
  constructor(private readonly baseUrl: string) {}

  /** Asks the service whether it is up and what it can do. */
  async health(): Promise<VocalServiceHealth> {
    return this.request<VocalServiceHealth>('/health')
  }

  async providers(): Promise<VocalServiceProvider[]> {
    const health = await this.health()
    return health.providers ?? []
  }

  /**
   * Hands a WAV file to the service and starts a job.
   *
   * The file travels as multipart form data rather than as a path: the
   * service may well run on another machine, where the app's paths mean
   * nothing.
   */
  async start(
    sourceWav: string,
    options: { provider?: string; model?: string; name?: string }
  ): Promise<string> {
    const bytes = await readFile(sourceWav)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'source.wav')
    if (options.provider) form.append('provider', options.provider)
    if (options.model) form.append('model', options.model)
    if (options.name) form.append('name', options.name)

    const response = await this.fetch('/separate', { method: 'POST', body: form }, UPLOAD_TIMEOUT)
    const payload = (await response.json()) as { job_id?: string; error?: string }
    if (!response.ok || !payload.job_id) {
      throw new VocalServiceError(payload.error ?? `分离服务返回 ${response.status}`)
    }
    return payload.job_id
  }

  async job(id: string): Promise<VocalJob> {
    const raw = await this.request<Record<string, unknown>>(`/jobs/${encodeURIComponent(id)}`)
    return normaliseJob(raw)
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  }

  /** Downloads the finished audio. */
  async download(fileId: string): Promise<Buffer> {
    const response = await this.fetch(`/files/${encodeURIComponent(fileId)}`, undefined, UPLOAD_TIMEOUT)
    if (!response.ok) {
      throw new VocalServiceError(`下载分离结果失败（${response.status}）`)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new VocalServiceError(text.slice(0, 300) || `分离服务返回 ${response.status}`)
    }
    return (await response.json()) as T
  }

  private async fetch(path: string, init?: RequestInit, timeoutMs = 5000): Promise<Response> {
    // A service that is not running must not hang the app: the request
    // gives up after a few seconds and the runner falls back. The calls that
    // carry data get a much longer leash.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new VocalServiceError(`无法连接分离服务（${this.baseUrl}）：${reason}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The service speaks snake_case; the app thinks in camelCase. */
function normaliseJob(raw: Record<string, unknown>): VocalJob {
  return {
    id: String(raw.job_id ?? raw.id ?? ''),
    status: (raw.status as VocalJob['status']) ?? 'queued',
    progress: Number(raw.progress ?? 0),
    message: String(raw.message ?? ''),
    provider: raw.provider ? String(raw.provider) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    resultPath: raw.result_path ? String(raw.result_path) : undefined,
    fileId: raw.file_id ? String(raw.file_id) : undefined,
    duration: raw.duration !== undefined ? Number(raw.duration) : undefined,
    error: raw.error ? String(raw.error) : undefined
  }
}
