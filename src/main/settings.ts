import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { DownloadSettings } from '@shared/types'

/**
 * The settings of the download workspace.
 *
 * They live in the user data folder, beside the list of downloads, so that
 * they survive a restart of the app. Nothing here belongs to a project:
 * the downloader is a tool of its own.
 */
const DEFAULTS: DownloadSettings = {
  ytdlpPath: '',
  outputDir: '',
  autoImport: false,
  url: '',
  cookiesFromBrowser: '',
  cookiesFile: '',
  subtitles: false,
  subLangs: 'zh-Hans,zh,en',
  maxParallel: 2,
  retries: 1,
  lastUpdateCheck: 0,
  latestVersion: ''
}

const SETTINGS_FILE = 'settings.json'

let cache: DownloadSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

/** Reads the settings, filling in whatever an older file does not have. */
export function getSettings(): DownloadSettings {
  if (cache) return { ...cache }
  let read: Partial<DownloadSettings> = {}
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<DownloadSettings>
    if (parsed && typeof parsed === 'object') read = parsed
  } catch {
    read = {}
  }
  cache = { ...DEFAULTS, ...read }
  return { ...cache }
}

/** Writes the settings. A failure here must not break the app. */
export function saveSettings(patch: Partial<DownloadSettings>): DownloadSettings {
  const next = { ...getSettings(), ...patch }
  cache = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* the settings are a convenience; losing them must not break the app */
  }
  return { ...next }
}

/** Whether a folder is still there to be written to. */
export function usableDir(dir: string): boolean {
  return !!dir && existsSync(dir)
}
