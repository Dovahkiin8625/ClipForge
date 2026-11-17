import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, shell } from 'electron'
import { DownloadRunner } from './download'
import { getSettings, saveSettings, usableDir } from './settings'
import { probeFile } from './media/probe'
import type {
  DownloadOptions,
  DownloadProgress,
  DownloadSettings,
  DownloadState,
  DownloadTask
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* The store on disk                                                  */
/* ------------------------------------------------------------------ */

const STORE_FILE = 'downloads.json'

interface Store {
  tasks: DownloadTask[]
}

function emptyProgress(): DownloadProgress {
  return { progress: 0, speed: '', eta: '--:--', totalSize: '', downloaded: '' }
}

/**
 * The failures that are worth trying again.
 *
 * A site that does not know the video, or a picture that is gone, will not
 * be there the next time either. A broken connection usually is.
 */
function retryable(reason: string): boolean {
  return reason === 'network' || reason === 'unknown'
}

/**
 * The download list.
 *
 * The list lives here, in the main process, so that it survives a switch
 * between workspaces, a reload of the window and a restart of the app.
 */
export class DownloadManager extends EventEmitter {
  private tasks: DownloadTask[] = []
  private queue: string[] = []
  private runners = new Map<string, DownloadRunner>()
  /** How many times a task has been tried. */
  private attempts = new Map<string, number>()
  private seq = 0
  private loaded = false

  constructor() {
    super()
  }

  /** The store is read the first time it is needed, not while the module is
   *  loaded, because the paths of the app are not known that early. */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    this.load()
  }

  /* ---------------------------------------------------------------- */
  /* Reading and writing the store                                     */
  /* ---------------------------------------------------------------- */

  private get storePath(): string {
    return join(app.getPath('userData'), STORE_FILE)
  }

  private load(): void {
    try {
      const raw = readFileSync(this.storePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<Store> & {
        form?: { url?: string; outputDir?: string; autoImport?: boolean }
      }
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(reviveTask) : []
      this.carryOver(parsed.form)
    } catch {
      this.tasks = []
    }
    // A task that was running when the app stopped cannot be resumed.
    for (const task of this.tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'cancelled'
        task.message = '已中断'
      }
    }
  }

  /**
   * The settings used to live beside the list; they are carried over so
   * that a link that was read before is not lost.
   */
  private carryOver(legacy?: {
    url?: string
    outputDir?: string
    autoImport?: boolean
  }): void {
    if (!legacy) return
    const settings = getSettings()
    const patch: Partial<DownloadSettings> = {}
    if (!settings.url && legacy.url) patch.url = legacy.url
    if (!settings.outputDir && legacy.outputDir) patch.outputDir = legacy.outputDir
    if (!settings.autoImport && legacy.autoImport) patch.autoImport = true
    if (Object.keys(patch).length > 0) saveSettings(patch)
  }

  private persist(): void {
    try {
      const store: Store = { tasks: this.tasks }
      writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf8')
    } catch {
      /* the list is a convenience; losing it must not break the app */
    }
  }

  private emitTasks(): void {
    this.emit('tasks', this.list())
  }

  /* ---------------------------------------------------------------- */
  /* The settings                                                      */
  /* ---------------------------------------------------------------- */

  settings(): DownloadSettings {
    this.ensureLoaded()
    const loaded = getSettings()
    // A folder that is gone is not worth keeping: the caller falls back
    // to the downloads folder.
    return {
      ...loaded,
      outputDir: usableDir(loaded.outputDir) ? loaded.outputDir : ''
    }
  }

  saveSettings(patch: Partial<DownloadSettings>): DownloadSettings {
    this.ensureLoaded()
    const next = saveSettings(patch)
    this.emit('settings', next)
    return next
  }

  /* ---------------------------------------------------------------- */
  /* The list                                                          */
  /* ---------------------------------------------------------------- */

  list(): DownloadTask[] {
    this.ensureLoaded()
    return this.tasks.map((t) => ({ ...t, progress: { ...t.progress } }))
  }

  private find(id: string): DownloadTask | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /* ---------------------------------------------------------------- */
  /* Starting, stopping                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Puts a download in the list and starts it as soon as there is room.
   * The queue lives here, so leaving the workspace does not interrupt
   * anything.
   */
  start(options: DownloadOptions & { title?: string }): DownloadTask {
    this.ensureLoaded()
    const id = `d_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
    const task: DownloadTask = {
      id,
      url: options.url,
      title: options.title || options.fileName || options.url,
      formatId: options.formatId ?? '',
      fileName: options.fileName ?? '',
      outputDir: options.outputDir,
      outputExt: options.outputExt ?? '',
      playlistItem: options.playlistItem,
      status: 'queued',
      message: '等待下载',
      progress: emptyProgress(),
      createdAt: Date.now()
    }
    this.tasks.unshift(task)
    this.queue.push(id)
    this.attempts.set(id, 0)
    this.persist()
    this.emitTasks()
    this.pump()
    return task
  }

  cancel(id: string): void {
    this.ensureLoaded()
    const task = this.find(id)
    if (!task) return
    const runner = this.runners.get(id)
    if (runner) {
      runner.cancel()
      return
    }
    // A task that has not started yet is simply dropped.
    this.queue = this.queue.filter((q) => q !== id)
    task.status = 'cancelled'
    task.message = '已取消'
    this.persist()
    this.emitTasks()
  }

  /** Puts a failed download back in the queue. */
  retry(id: string): void {
    this.ensureLoaded()
    const task = this.find(id)
    if (!task) return
    if (task.status === 'running' || task.status === 'queued') return
    this.attempts.set(id, 0)
    task.status = 'queued'
    task.message = '等待重试'
    task.failure = undefined
    task.progress = emptyProgress()
    this.queue.push(id)
    this.persist()
    this.emitTasks()
    this.pump()
  }

  remove(id: string): void {
    this.ensureLoaded()
    this.runners.get(id)?.cancel()
    this.queue = this.queue.filter((q) => q !== id)
    this.attempts.delete(id)
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.persist()
    this.emitTasks()
  }

  clearFinished(): void {
    this.ensureLoaded()
    this.tasks = this.tasks.filter(
      (t) => t.status === 'running' || t.status === 'queued'
    )
    this.persist()
    this.emitTasks()
  }

  /** Opens the finished file with the program the system uses for it. */
  async open(id: string): Promise<string> {
    this.ensureLoaded()
    const task = this.find(id)
    const path = task?.outputPath
    if (!path || !existsSync(path)) return '文件不存在'
    const err = await shell.openPath(path)
    return err ?? ''
  }

  /** Shows the finished file in the file manager. */
  reveal(id: string): string {
    this.ensureLoaded()
    const task = this.find(id)
    const path = task?.outputPath
    if (!path || !existsSync(path)) return '文件不存在'
    shell.showItemInFolder(path)
    return ''
  }

  /* ---------------------------------------------------------------- */
  /* The queue                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Starts as many downloads as there is room for.
   *
   * One at a time is slow when a page holds ten videos; too many at once
   * and they fight over the same connection and the same disk.
   */
  private pump(): void {
    const limit = Math.max(1, Math.min(3, getSettings().maxParallel))
    while (this.runners.size < limit) {
      const id = this.queue.shift()
      if (!id) return
      const task = this.find(id)
      if (!task) continue
      void this.run(task)
    }
  }

  /** Runs one download from beginning to end. */
  private async run(task: DownloadTask): Promise<void> {
    const id = task.id
    const settings = getSettings()

    task.status = 'running'
    task.message = '正在准备下载…'
    task.failure = undefined
    task.progress = emptyProgress()
    this.emitTasks()

    const runner = new DownloadRunner()
    this.runners.set(id, runner)

    const onState = (s: DownloadState): void => {
      const current = this.find(id)
      if (!current) return
      current.status = s.status
      current.message = s.message
      current.progress = { ...s.progress }
      if (s.outputPath) current.outputPath = s.outputPath
      if (s.failure) current.failure = s.failure
      this.emit('state', s)
      this.emitTasks()
    }
    runner.on('state', onState)

    try {
      await runner.run({
        url: task.url,
        formatId: task.formatId || undefined,
        outputDir: task.outputDir,
        fileName: task.fileName || undefined,
        outputExt: task.outputExt || undefined,
        playlistItem: task.playlistItem,
        cookiesFromBrowser: settings.cookiesFromBrowser || undefined,
        cookiesFile: settings.cookiesFile || undefined,
        subtitles: settings.subtitles,
        subLangs: settings.subLangs
      })
      const current = this.find(id)
      if (current && current.status === 'running') {
        current.status = 'done'
        current.message = '下载完成'
      }
      await this.verify(current)
    } catch (err) {
      const current = this.find(id)
      if (current && current.status !== 'cancelled') {
        const attempt = this.attempts.get(id) ?? 0
        const failure = current.failure
        if (failure && retryable(failure.reason) && attempt < settings.retries) {
          // The connection broke; it is worth trying once more.
          const wait = (attempt + 1) * 3000
          this.attempts.set(id, attempt + 1)
          current.status = 'queued'
          current.message = `连接断了，${Math.round(wait / 1000)} 秒后重试`
          setTimeout(() => {
            this.queue.push(id)
            this.pump()
          }, wait)
        } else {
          current.status = 'error'
          current.message = err instanceof Error ? err.message : String(err)
        }
      }
    } finally {
      runner.off('state', onState)
      this.runners.delete(id)
      this.persist()
      this.emitTasks()
      this.pump()
    }
  }

  /**
   * Reads what the finished file turned out to be.
   *
   * A file that cannot be read is not thrown away: the path is what
   * matters, and the file may still play.
   */
  private async verify(task: DownloadTask | undefined): Promise<void> {
    if (!task) return
    const path = task.outputPath
    if (!path || !existsSync(path)) return
    try {
      const probe = await probeFile(path)
      const current = this.find(task.id)
      if (!current) return
      current.media = {
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        sizeBytes: probe.sizeBytes,
        hasAudio: probe.hasAudio
      }
    } catch {
      /* the file may still be fine */
    }
  }
}

/** Fills in the fields a task from an older store may be missing. */
function reviveTask(raw: DownloadTask): DownloadTask {
  return {
    ...raw,
    title: raw.title || raw.fileName || raw.url,
    formatId: raw.formatId ?? '',
    fileName: raw.fileName ?? '',
    outputExt: raw.outputExt ?? '',
    message: raw.message ?? '',
    progress: { ...emptyProgress(), ...(raw.progress ?? {}) },
    createdAt: raw.createdAt ?? Date.now()
  }
}
