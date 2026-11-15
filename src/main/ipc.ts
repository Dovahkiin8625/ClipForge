import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { buildSprite } from './media/thumbs'
import { extractWaveform } from './media/waveform'
import { probeFile } from './media/probe'
import { ffmpegPath, ffprobePath, ffmpegVersion } from './ffmpeg'
import { toMediaUrl } from './protocol'
import { AUDIO_FORMATS, ExportRunner } from './export/run'
import { ConvertRunner } from './convert'
import {
  parseVideo,
  rememberYtdlp,
  ytdlpInfo
} from './download'
import { DownloadManager } from './downloads'
import { VocalRunner } from './vocals/runner'
import type {
  AppInfo,
  ConvertOptions,
  ConvertProgress,
  ConvertState,
  DownloadForm,
  DownloadOptions,
  DownloadState,
  DownloadTask,
  ExportOptions,
  ExportProgress,
  ExportRequest,
  ExportState,
  ImportedAsset,
  Project,
  VideoInfo,
  YtdlpInfo
} from '@shared/types'
import type { VocalSeparateRequest, VocalState } from '@shared/vocals'

const runner = new ExportRunner()
const converter = new ConvertRunner()
const downloader = new DownloadManager()
const vocalist = new VocalRunner()

const MEDIA_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg',
  'ts', '3gp', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'
]

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

runner.on('progress', (p: ExportProgress) => broadcast('export:progress', p))
runner.on('state', (s: ExportState) => broadcast('export:state', s))
converter.on('progress', (p: ConvertProgress) => broadcast('convert:progress', p))
converter.on('state', (s: ConvertState) => broadcast('convert:state', s))
downloader.on('state', (s: DownloadState) => broadcast('download:state', s))
downloader.on('tasks', (t: DownloadTask[]) => broadcast('download:tasks', t))
vocalist.on('state', (s: VocalState) => broadcast('vocal:state', s))

async function importPaths(paths: string[]): Promise<ImportedAsset[]> {
  const assets: ImportedAsset[] = []
  for (const path of paths) {
    try {
      const probe = await probeFile(path)
      assets.push({
        id: `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: probe.name,
        path: probe.path,
        kind: probe.kind,
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
        codec: probe.codec,
        sizeBytes: probe.sizeBytes,
        waveformBuckets: 0,
        createdAt: Date.now(),
        url: toMediaUrl(probe.path)
      })
    } catch (err) {
      // A single unreadable file should not abort the whole import.
      console.error(`[clipforge] failed to import ${path}:`, err)
    }
  }
  return assets
}

export function registerIpc(): void {
  ipcMain.handle('app:info', (): AppInfo => {
    return {
      ffmpegPath: ffmpegPath() ?? '',
      ffprobePath: ffprobePath() ?? '',
      version: ffmpegVersion(),
      platform: process.platform
    }
  })

  ipcMain.handle('media:importFiles', async (): Promise<ImportedAsset[]> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '导入媒体',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有媒体', extensions: MEDIA_EXTENSIONS },
        { name: '视频', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'] },
        { name: '音频', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return importPaths(result.filePaths)
  })

  ipcMain.handle('media:importPaths', async (_e, paths: string[]): Promise<ImportedAsset[]> => {
    return importPaths(Array.isArray(paths) ? paths : [])
  })

  ipcMain.handle('media:sprite', async (_e, args: {
    path: string
    startTime: number
    endTime: number
    columns: number
    frameWidth?: number
    sourceWidth?: number
    sourceHeight?: number
    still?: boolean
  }) => {
    return buildSprite({
      path: args.path,
      startTime: args.startTime,
      endTime: args.endTime,
      columns: args.columns,
      frameWidth: args.frameWidth,
      sourceWidth: args.sourceWidth,
      sourceHeight: args.sourceHeight,
      still: args.still
    })
  })

  ipcMain.handle('media:waveform', async (_e, args: { path: string; duration: number }) => {
    const result = await extractWaveform(args.path, args.duration)
    // Float32Array cannot cross the IPC boundary as-is; send a plain array.
    return { peaks: Array.from(result.peaks), buckets: result.buckets }
  })

  ipcMain.handle('project:save', async (_e, project: Project, filePath: string) => {
    await writeFile(filePath, JSON.stringify(project, null, 2), 'utf8')
  })

  ipcMain.handle('project:load', async (_e, filePath: string): Promise<Project | null> => {
    try {
      const raw = await readFile(filePath, 'utf8')
      return JSON.parse(raw) as Project
    } catch {
      return null
    }
  })

  ipcMain.handle('project:chooseSaveProject', async (_e, defaultName: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, {
      title: '保存项目',
      defaultPath: `${defaultName}.clipforge.json`,
      filters: [{ name: 'ClipForge 项目', extensions: ['json'] }]
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  ipcMain.handle('project:chooseOpenProject', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '打开项目',
      properties: ['openFile'],
      filters: [{ name: 'ClipForge 项目', extensions: ['json'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('export:start', async (_e, project: Project, options: ExportOptions) => {
    if (runner.running) throw new Error('已有导出任务正在进行')
    try {
      await runner.run(project, options)
    } catch (err) {
      // The state event already carries the user-facing message.
      console.error('[clipforge] export failed:', err)
    }
  })

  ipcMain.handle('export:cancel', async () => {
    runner.cancel()
  })

  ipcMain.handle('export:chooseOutput', async (_e, request: ExportRequest) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const name = request.defaultName || 'clipforge'

    if (request.kind === 'audio') {
      const spec = AUDIO_FORMATS[request.format ?? 'mp3'] ?? AUDIO_FORMATS.mp3
      const result = await dialog.showSaveDialog(win, {
        title: '导出音频',
        defaultPath: `${name}.${spec.ext}`,
        filters: [{ name: `${spec.label} 音频`, extensions: [spec.ext] }]
      })
      return result.canceled ? null : (result.filePath ?? null)
    }

    if (request.kind === 'gif') {
      const result = await dialog.showSaveDialog(win, {
        title: '导出 GIF',
        defaultPath: `${name}.gif`,
        filters: [{ name: 'GIF 动图', extensions: ['gif'] }]
      })
      return result.canceled ? null : (result.filePath ?? null)
    }

    const result = await dialog.showSaveDialog(win, {
      title: '导出视频',
      defaultPath: `${name}.mp4`,
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    return result.canceled ? null : (result.filePath ?? null)
  })

  ipcMain.handle('export:reveal', async (_e, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('dialog:message', async (_e, options: {
    type?: 'info' | 'error' | 'warning'
    title?: string
    message: string
  }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    await dialog.showMessageBox(win, {
      type: options.type ?? 'info',
      title: options.title ?? 'ClipForge',
      message: options.message,
      buttons: ['好']
    })
  })

  ipcMain.handle('app:userDataPath', () => app.getPath('userData'))

  ipcMain.handle('app:downloadsPath', () => app.getPath('downloads'))

  ipcMain.handle('media:probe', async (_e, path: string) => probeFile(path))

  /* ---------------------------------------------------------------- */
  /* Conversion                                                        */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('convert:chooseInput', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择要转换的文件',
      properties: ['openFile'],
      filters: [
        { name: '所有媒体', extensions: MEDIA_EXTENSIONS },
        { name: '视频', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'] },
        { name: '音频', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('convert:chooseOutputDir', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择输出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('convert:start', async (_e, options: ConvertOptions) => {
    if (converter.running) throw new Error('已有转换任务正在进行')
    try {
      await converter.run(options)
    } catch (err) {
      // The state event already carries the user-facing message.
      console.error('[clipforge] conversion failed:', err)
    }
  })

  ipcMain.handle('convert:cancel', async () => {
    converter.cancel()
  })

  /* ---------------------------------------------------------------- */
  /* Download                                                          */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('download:locate', async (): Promise<YtdlpInfo> => ytdlpInfo())

  ipcMain.handle('download:chooseBinary', async (): Promise<YtdlpInfo> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择 yt-dlp 可执行文件',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: '可执行文件', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    })
    const picked = result.canceled ? null : (result.filePaths[0] ?? null)
    if (picked) rememberYtdlp(picked)
    return ytdlpInfo()
  })

  ipcMain.handle('download:parse', async (_e, url: string): Promise<VideoInfo> => {
    return parseVideo(url)
  })

  ipcMain.handle('download:start', async (_e, options: DownloadOptions) => {
    return downloader.start(options)
  })

  ipcMain.handle('download:tasks', async (): Promise<DownloadTask[]> => downloader.list())

  ipcMain.handle('download:cancel', async (_e, id: string) => {
    downloader.cancel(id)
  })

  ipcMain.handle('download:remove', async (_e, id: string) => {
    downloader.remove(id)
  })

  ipcMain.handle('download:clearFinished', async () => {
    downloader.clearFinished()
  })

  ipcMain.handle('download:open', async (_e, id: string) => {
    const error = await downloader.open(id)
    if (error) throw new Error(error)
  })

  ipcMain.handle('download:reveal', async (_e, id: string) => {
    const error = downloader.reveal(id)
    if (error) throw new Error(error)
  })

  ipcMain.handle('download:getForm', async (): Promise<DownloadForm> => downloader.getForm())

  ipcMain.handle('download:saveForm', async (_e, form: DownloadForm) => {
    downloader.saveForm(form)
  })

  /* ---------------------------------------------------------------- */
  /* Vocal separation                                                 */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('vocal:providers', async () => {
    return vocalist.providers()
  })

  ipcMain.handle('vocal:separate', async (_e, request: VocalSeparateRequest) => {
    if (vocalist.busy) throw new Error('已有人声分离任务正在进行')
    try {
      return await vocalist.run(request)
    } catch (err) {
      // The state event already carries the user-facing message.
      console.error('[clipforge] vocal separation failed:', err)
      throw err
    }
  })

  ipcMain.handle('vocal:cancel', async () => {
    vocalist.cancel()
  })
}
