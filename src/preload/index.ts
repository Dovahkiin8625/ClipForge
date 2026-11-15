import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  ConvertOptions,
  ConvertProgress,
  ConvertState,
  DownloadOptions,
  DownloadState,
  DownloadTask,
  DownloadForm,
  ExportOptions,
  ExportProgress,
  ExportRequest,
  ExportState,
  ImportedAsset,
  Project,
  ProbeResult,
  SpriteSheet,
  Unsubscribe,
  VideoInfo,
  YtdlpInfo
} from '@shared/types'
import type {
  VocalProviderInfo,
  VocalSeparateRequest,
  VocalSeparateResult,
  VocalState
} from '@shared/vocals'

const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    downloadsPath: (): Promise<string> => ipcRenderer.invoke('app:downloadsPath')
  },
  media: {
    importFiles: (): Promise<ImportedAsset[]> => ipcRenderer.invoke('media:importFiles'),
    probe: (path: string): Promise<ProbeResult> => ipcRenderer.invoke('media:probe', path),
    importPaths: (paths: string[]): Promise<ImportedAsset[]> =>
      ipcRenderer.invoke('media:importPaths', paths),
    sprite: (
      path: string,
      startTime: number,
      endTime: number,
      columns: number,
      frameWidth?: number,
      still?: boolean
    ): Promise<SpriteSheet> =>
      ipcRenderer.invoke('media:sprite', { path, startTime, endTime, columns, frameWidth, still }),
    waveform: (path: string, duration: number): Promise<{ peaks: number[]; buckets: number }> =>
      ipcRenderer.invoke('media:waveform', { path, duration }),
    /** Resolves the absolute path of a dropped `File` (Electron ≥ 32 removed `File.path`). */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  project: {
    save: (project: Project, filePath: string): Promise<void> =>
      ipcRenderer.invoke('project:save', project, filePath),
    load: (filePath: string): Promise<Project | null> =>
      ipcRenderer.invoke('project:load', filePath),
    chooseSaveProject: (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke('project:chooseSaveProject', defaultName),
    chooseOpenProject: (): Promise<string | null> =>
      ipcRenderer.invoke('project:chooseOpenProject')
  },
  export: {
    start: (project: Project, options: ExportOptions): Promise<void> =>
      ipcRenderer.invoke('export:start', project, options),
    cancel: (): Promise<void> => ipcRenderer.invoke('export:cancel'),
    chooseOutput: (request: ExportRequest): Promise<string | null> =>
      ipcRenderer.invoke('export:chooseOutput', request),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('export:reveal', path),
    onProgress: (cb: (p: ExportProgress) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: ExportProgress): void => cb(payload)
      ipcRenderer.on('export:progress', handler)
      return () => ipcRenderer.removeListener('export:progress', handler)
    },
    onState: (cb: (s: ExportState) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: ExportState): void => cb(payload)
      ipcRenderer.on('export:state', handler)
      return () => ipcRenderer.removeListener('export:state', handler)
    }
  },
  dialog: {
    message: (options: {
      type?: 'info' | 'error' | 'warning'
      title?: string
      message: string
    }): Promise<void> => ipcRenderer.invoke('dialog:message', options)
  },
  convert: {
    chooseInput: (): Promise<string | null> => ipcRenderer.invoke('convert:chooseInput'),
    chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('convert:chooseOutputDir'),
    start: (options: ConvertOptions): Promise<void> =>
      ipcRenderer.invoke('convert:start', options),
    cancel: (): Promise<void> => ipcRenderer.invoke('convert:cancel'),
    onProgress: (cb: (p: ConvertProgress) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: ConvertProgress): void =>
        cb(payload)
      ipcRenderer.on('convert:progress', handler)
      return () => ipcRenderer.removeListener('convert:progress', handler)
    },
    onState: (cb: (s: ConvertState) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: ConvertState): void => cb(payload)
      ipcRenderer.on('convert:state', handler)
      return () => ipcRenderer.removeListener('convert:state', handler)
    }
  },
  download: {
    locate: (): Promise<YtdlpInfo> => ipcRenderer.invoke('download:locate'),
    chooseBinary: (): Promise<YtdlpInfo> => ipcRenderer.invoke('download:chooseBinary'),
    parse: (url: string): Promise<VideoInfo> => ipcRenderer.invoke('download:parse', url),
    start: (options: DownloadOptions): Promise<DownloadTask> =>
      ipcRenderer.invoke('download:start', options),
    tasks: (): Promise<DownloadTask[]> => ipcRenderer.invoke('download:tasks'),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('download:cancel', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('download:remove', id),
    clearFinished: (): Promise<void> => ipcRenderer.invoke('download:clearFinished'),
    open: (id: string): Promise<void> => ipcRenderer.invoke('download:open', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('download:reveal', id),
    getForm: (): Promise<DownloadForm> => ipcRenderer.invoke('download:getForm'),
    saveForm: (form: DownloadForm): Promise<void> =>
      ipcRenderer.invoke('download:saveForm', form),
    onState: (cb: (s: DownloadState) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: DownloadState): void =>
        cb(payload)
      ipcRenderer.on('download:state', handler)
      return () => ipcRenderer.removeListener('download:state', handler)
    },
    onTasks: (cb: (tasks: DownloadTask[]) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: DownloadTask[]): void =>
        cb(payload)
      ipcRenderer.on('download:tasks', handler)
      return () => ipcRenderer.removeListener('download:tasks', handler)
    }
  },
  vocal: {
    /** The separation methods that are available right now. */
    providers: (): Promise<VocalProviderInfo[]> => ipcRenderer.invoke('vocal:providers'),
    /** Separates the voice out of a clip's audio. */
    separate: (request: VocalSeparateRequest): Promise<VocalSeparateResult> =>
      ipcRenderer.invoke('vocal:separate', request),
    cancel: (): Promise<void> => ipcRenderer.invoke('vocal:cancel'),
    onState: (cb: (s: VocalState) => void): Unsubscribe => {
      const handler = (_e: Electron.IpcRendererEvent, payload: VocalState): void => cb(payload)
      ipcRenderer.on('vocal:state', handler)
      return () => ipcRenderer.removeListener('vocal:state', handler)
    }
  }
}

export type ClipForgeApi = typeof api

contextBridge.exposeInMainWorld('clipforge', api)
