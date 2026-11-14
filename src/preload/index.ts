import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AppInfo,
  ExportOptions,
  ExportProgress,
  ExportRequest,
  ExportState,
  ImportedAsset,
  Project,
  SpriteSheet,
  Unsubscribe
} from '@shared/types'

const api = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
  },
  media: {
    importFiles: (): Promise<ImportedAsset[]> => ipcRenderer.invoke('media:importFiles'),
    importPaths: (paths: string[]): Promise<ImportedAsset[]> =>
      ipcRenderer.invoke('media:importPaths', paths),
    sprite: (
      path: string,
      startTime: number,
      endTime: number,
      columns: number,
      frameWidth?: number
    ): Promise<SpriteSheet> =>
      ipcRenderer.invoke('media:sprite', { path, startTime, endTime, columns, frameWidth }),
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
  }
}

export type ClipForgeApi = typeof api

contextBridge.exposeInMainWorld('clipforge', api)
