import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  ConvertOptions,
  ConvertProgress,
  ConvertState,
  DownloadOptions,
  DownloadSettings,
  DownloadState,
  DownloadTask,
  ExportOptions,
  ExportProgress,
  ExportRequest,
  ExportState,
  ImportedAsset,
  Poster,
  Project,
  ProbeResult,
  SpriteSheet,
  Unsubscribe,
  VideoEntry,
  VideoList,
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
      still?: boolean,
      sourceWidth?: number,
      sourceHeight?: number
    ): Promise<SpriteSheet> =>
      ipcRenderer.invoke('media:sprite', {
        path,
        startTime,
        endTime,
        columns,
        frameWidth,
        still,
        sourceWidth,
        sourceHeight
      }),
    /** A single picture of a recording, for the card in the library. */
    poster: (path: string, time: number, frameWidth?: number): Promise<Poster | null> =>
      ipcRenderer.invoke('media:poster', { path, time, frameWidth }),
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
    parseList: (url: string): Promise<VideoList> =>
      ipcRenderer.invoke('download:parseList', url),
    scanPage: (url: string): Promise<VideoList> =>
      ipcRenderer.invoke('download:scanPage', url),
    loadEntry: (url: string, playlistItem?: number): Promise<VideoEntry> =>
      ipcRenderer.invoke('download:loadEntry', url, playlistItem),
    start: (options: DownloadOptions): Promise<DownloadTask> =>
      ipcRenderer.invoke('download:start', options),
    tasks: (): Promise<DownloadTask[]> => ipcRenderer.invoke('download:tasks'),
    cancel: (id: string): Promise<void> => ipcRenderer.invoke('download:cancel', id),
    retry: (id: string): Promise<void> => ipcRenderer.invoke('download:retry', id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('download:remove', id),
    clearFinished: (): Promise<void> => ipcRenderer.invoke('download:clearFinished'),
    open: (id: string): Promise<void> => ipcRenderer.invoke('download:open', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('download:reveal', id),
    settings: (): Promise<DownloadSettings> => ipcRenderer.invoke('download:settings'),
    saveSettings: (patch: Partial<DownloadSettings>): Promise<DownloadSettings> =>
      ipcRenderer.invoke('download:saveSettings', patch),
    chooseCookiesFile: (): Promise<string> =>
      ipcRenderer.invoke('download:chooseCookiesFile'),
    cover: (url: string): Promise<string> => ipcRenderer.invoke('download:cover', url),
    checkUpdate: (force?: boolean): Promise<{ current: string; latest: string; hasUpdate: boolean }> =>
      ipcRenderer.invoke('download:checkUpdate', force),
    updateYtdlp: (): Promise<{ version: string; path: string }> =>
      ipcRenderer.invoke('download:updateYtdlp'),
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
    },
    onSettings: (cb: (settings: DownloadSettings) => void): Unsubscribe => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: DownloadSettings
      ): void => cb(payload)
      ipcRenderer.on('download:settings', handler)
      return () => ipcRenderer.removeListener('download:settings', handler)
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
