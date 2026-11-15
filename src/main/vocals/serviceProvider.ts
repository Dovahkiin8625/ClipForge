import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { VocalServiceModel, VocalServiceProvider } from '@shared/vocals'
import type { VocalProvider, VocalProviderContext } from './provider'
import type { VocalServiceClient } from './serviceClient'

/** How often the client asks the service how far along the job is. */
const POLL_INTERVAL = 500

/** A separation job may run for a long time; the clock is generous. */
const JOB_TIMEOUT = 60 * 60 * 1000

/**
 * A provider that lives inside the separation service.
 *
 * The service may hold several providers — several models, or a filter of its
 * own — and the app treats each of them as a provider of its own. A model
 * that the service learns about tomorrow becomes usable without a change
 * anywhere in the app.
 */
export class ServiceVocalProvider implements VocalProvider {
  readonly id: string
  readonly label: string
  readonly kind: VocalServiceProvider['kind']
  readonly modelId: string | undefined
  private readonly models_: VocalServiceModel[]
  private readonly model: string | undefined

  constructor(
    private readonly client: VocalServiceClient,
    descriptor: VocalServiceProvider,
    /** The model to run; the first one when the caller does not care. */
    model?: string
  ) {
    this.id = descriptor.id
    this.label = descriptor.label
    this.kind = descriptor.kind
    this.models_ = descriptor.models ?? []
    this.model = model ?? this.models_[0]?.id
    this.modelId = this.model
  }

  async models(): Promise<VocalServiceModel[]> {
    return this.models_
  }

  async available(): Promise<{ available: boolean; reason?: string }> {
    return { available: true, reason: undefined }
  }

  async separate(
    sourceWav: string,
    ctx: VocalProviderContext
  ): Promise<{ path: string; duration: number }> {
    ctx.report(0, '正在提交分离任务…')
    const jobId = await this.client.start(sourceWav, {
      provider: this.id,
      model: this.model,
      name: 'vocals'
    })

    const deadline = Date.now() + JOB_TIMEOUT
    let job = await this.client.job(jobId)

    while (job.status === 'queued' || job.status === 'running') {
      if (ctx.cancelled()) {
        await this.client.cancel(jobId).catch(() => undefined)
        throw new Error('已取消人声分离')
      }
      if (Date.now() > deadline) {
        await this.client.cancel(jobId).catch(() => undefined)
        throw new Error('人声分离超时')
      }
      ctx.report(job.progress, job.message || '正在分离人声…')
      await sleep(POLL_INTERVAL)
      job = await this.client.job(jobId)
    }

    if (job.status === 'cancelled') throw new Error('人声分离已取消')
    if (job.status === 'error') throw new Error(job.error || '人声分离失败')
    if (!job.fileId) throw new Error('分离服务没有返回结果文件')

    ctx.report(0.99, '正在接收分离结果…')
    const bytes = await this.client.download(job.fileId)
    const output = join(ctx.workDir, `vocals-${this.id}.wav`)
    await writeFile(output, bytes)

    ctx.report(1, '人声分离完成')
    return { path: output, duration: job.duration ?? 0 }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
