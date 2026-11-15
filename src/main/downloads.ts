import { EventEmitter } from 'events'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, shell } from 'electron'
import { DownloadRunner } from './download'
import type {
  DownloadForm,
  DownloadOptions,
  DownloadProgress,
  DownloadState,
  DownloadTask
} from '@shared/types'

/* ------------------------------------------------------------------ */
/* The store on disk                                                  */
/* ------------------------------------------------------------------ */

const STORE_FILE = 'downloads.json'

interface Store {
  tasks: DownloadTask[]
  form: DownloadForm
}

const EMPTY_FORM: DownloadForm = {
  url: '',
  formatId: '',
  fileName: '',
  outputDir: '',
  autoImport: false
}

function emptyProgress(): DownloadProgress {
  return { progress: 0, speed: '', eta: '--:--', totalSize: '', downloaded: '' }
}

/**
 * The download list and the download form, kept in the user data folder.
 *
 * The list lives here, in the main process, so that it survives a switch
 * between workspaces, a reload of the window and a restart of the app.
 */
export class DownloadManager extends EventEmitter {
  private tasks: DownloadTask[] = []
  private form: DownloadForm = { ...EMPTY_FORM }
  private queue: string[] = []
  private runner: DownloadRunner | null = null
  private currentId: string | null = null
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
      const parsed = JSON.parse(raw) as Partial<Store>
      this.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(reviveTask) : []
      this.form = { ...EMPTY_FORM, ...(parsed.form ?? {}) }
    } catch {
      this.tasks = []
      this.form = { ...EMPTY_FORM }
    }
    // A task that was running when the app stopped cannot be resumed.
    for (const task of this.tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'cancelled'
        task.message = '已中断'
      }
    }
  }

  private persist(): void {
    try {
      const store: Store = { tasks: this.tasks, form: this.form }
      writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf8')
    } catch {
      /* the list is a convenience; losing it must not break the app */
    }
  }

  private emitTasks(): void {
    this.emit('tasks', this.list())
  }

  /* ---------------------------------------------------------------- */
  /* The list                                                          */
  /* ---------------------------------------------------------------- */

  list(): DownloadTask[] {
    this.ensureLoaded()
    return this.tasks.map((t) => ({ ...t, progress: { ...t.progress } }))
  }

  getForm(): DownloadForm {
    this.ensureLoaded()
    return { ...this.form }
  }

  saveForm(form: Partial<DownloadForm>): DownloadForm {
    this.ensureLoaded()
    this.form = { ...this.form, ...form }
    this.persist()
    return this.getForm()
  }

  private find(id: string): DownloadTask | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /* ---------------------------------------------------------------- */
  /* Starting, stopping                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Puts a download in the list and starts it as soon as the running one
   * is through. The queue lives here, so leaving the workspace does not
   * interrupt anything.
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
      status: 'queued',
      message: '等待下载',
      progress: emptyProgress(),
      createdAt: Date.now()
    }
    this.tasks.unshift(task)
    this.queue.push(id)
    this.persist()
    this.emitTasks()
    void this.pump()
    return task
  }

  cancel(id: string): void {
    this.ensureLoaded()
    const task = this.find(id)
    if (!task) return
    if (id === this.currentId) {
      this.runner?.cancel()
      return
    }
    // A task that has not started yet is simply dropped.
    this.queue = this.queue.filter((q) => q !== id)
    task.status = 'cancelled'
    task.message = '已取消'
    this.persist()
    this.emitTasks()
  }

  remove(id: string): void {
    this.ensureLoaded()
    if (id === this.currentId) this.runner?.cancel()
    this.queue = this.queue.filter((q) => q !== id)
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

  private async pump(): Promise<void> {
    if (this.runner) return
    const id = this.queue.shift()
    if (!id) return
    const task = this.find(id)
    if (!task) {
      void this.pump()
      return
    }

    this.currentId = id
    task.status = 'running'
    task.message = '正在准备下载…'
    task.progress = emptyProgress()
    this.emitTasks()

    const runner = new DownloadRunner()
    this.runner = runner

    const onState = (s: DownloadState): void => {
      const current = this.find(id)
      if (!current) return
      current.status = s.status
      current.message = s.message
      current.progress = { ...s.progress }
      if (s.outputPath) current.outputPath = s.outputPath
      this.emit('state', s)
      this.emitTasks()
    }
    runner.on('state', onState)

    try {
      await runner.run({
        url: task.url,
        formatId: task.formatId || undefined,
        outputDir: task.outputDir,
        fileName: task.fileName || undefined
      })
      const current = this.find(id)
      if (current && current.status === 'running') {
        current.status = 'done'
        current.message = '下载完成'
      }
    } catch (err) {
      const current = this.find(id)
      if (current && current.status !== 'cancelled') {
        current.status = 'error'
        current.message = err instanceof Error ? err.message : String(err)
      }
    } finally {
      runner.off('state', onState)
      this.runner = null
      this.currentId = null
      this.persist()
      this.emitTasks()
    }

    void this.pump()
  }
}

/** Fills in the fields a task from an older store may be missing. */
function reviveTask(raw: DownloadTask): DownloadTask {
  return {
    ...raw,
    title: raw.title || raw.fileName || raw.url,
    formatId: raw.formatId ?? '',
    fileName: raw.fileName ?? '',
    message: raw.message ?? '',
    progress: { ...emptyProgress(), ...(raw.progress ?? {}) },
    createdAt: raw.createdAt ?? Date.now()
  }
}
