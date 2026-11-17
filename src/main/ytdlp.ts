import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { getSettings, saveSettings } from './settings'
import type { YtdlpInfo } from '@shared/types'

/* ------------------------------------------------------------------ */
/* Finding the binary                                                  */
/* ------------------------------------------------------------------ */

function which(bin: string): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, [bin], { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return null
  const first = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)
  return first ? first.trim() : null
}

/**
 * The command that runs yt-dlp.
 *
 * The environment override may carry arguments (`python -m yt_dlp`), so it
 * is split into the binary and the arguments that come before every call.
 */
export interface YtdlpCommand {
  bin: string
  prefix: string[]
}

function splitCommand(raw: string): YtdlpCommand {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  return { bin: parts[0] ?? raw.trim(), prefix: parts.slice(1) }
}

/** The name the binary has on this system. */
function binaryName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return 'yt-dlp'
}

/**
 * Where the app keeps the copy it updates.
 *
 * It sits in the user data folder, which the app may always write to,
 * unlike the folder it was installed in.
 */
export function updatedYtdlpPath(): string {
  return join(app.getPath('userData'), 'bin', binaryName())
}

/**
 * Finds the yt-dlp binary.
 *
 * The order follows how likely the user is to have the newest one: an
 * explicit environment override, the copy the app updates, the path they
 * picked in the app, the copy shipped with the packaged build, and
 * finally the system PATH.
 */
export function ytdlpCommand(): YtdlpCommand | null {
  const env = process.env['CLIPFORGE_YTDLP']
  if (env) {
    const cmd = splitCommand(env)
    if (cmd.bin) {
      // The override may name a program rather than a path.
      const resolved = existsSync(cmd.bin) ? cmd.bin : which(cmd.bin)
      if (resolved) return { bin: resolved, prefix: cmd.prefix }
    }
  }

  // The copy the app keeps up to date.
  const updated = updatedYtdlpPath()
  if (existsSync(updated)) return { bin: updated, prefix: [] }

  const chosen = getSettings().ytdlpPath
  if (chosen && existsSync(chosen)) return { bin: chosen, prefix: [] }

  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'bin', binaryName())
    if (existsSync(bundled)) return { bin: bundled, prefix: [] }
  }

  const names = process.platform === 'win32' ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp']
  const onPath = names.map((n) => which(n)).find((p): p is string => !!p)
  if (onPath) return { bin: onPath, prefix: [] }

  return null
}

export function ytdlpPath(): string | null {
  return ytdlpCommand()?.bin ?? null
}

/** Remembers a yt-dlp binary the user picked by hand. */
export function rememberYtdlp(path: string): void {
  saveSettings({ ytdlpPath: path })
}

/** The version of the binary that would be used right now. */
export function ytdlpVersion(): string {
  const cmd = ytdlpCommand()
  if (!cmd) return ''
  const r = spawnSync(cmd.bin, [...cmd.prefix, '--version'], {
    encoding: 'utf8',
    timeout: 10000
  })
  if (r.error || r.status !== 0) return ''
  return (r.stdout ?? '').trim().split(/\r?\n/)[0] ?? ''
}

export function ytdlpInfo(): YtdlpInfo {
  const cmd = ytdlpCommand()
  if (!cmd) {
    return {
      available: false,
      path: '',
      version: '',
      hint:
        '未找到 yt-dlp。下载功能需要它来读取链接信息。' +
        '请从 https://github.com/yt-dlp/yt-dlp/releases 下载后，' +
        '点击「指定路径」选择该可执行文件。'
    }
  }
  return { available: true, path: cmd.bin, version: ytdlpVersion(), hint: '' }
}

/* ------------------------------------------------------------------ */
/* Updating                                                            */
/* ------------------------------------------------------------------ */

/** What the app knows about the newest version of yt-dlp. */
export interface YtdlpRelease {
  /** The version, e.g. "2026.11.10". */
  version: string
  /** Where the file is fetched from. */
  url: string
  /** The size of the file in bytes. */
  size: number
}

const RELEASE_API =
  'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'

/**
 * Asks GitHub which version of yt-dlp is the newest.
 *
 * The sites change their pages all the time, and yt-dlp is updated for
 * that reason alone. An old copy stops being able to read half the sites
 * there are, so it is worth knowing when a new one is out.
 */
export async function latestYtdlp(): Promise<YtdlpRelease | null> {
  const response = await fetch(RELEASE_API, {
    headers: {
      'User-Agent': 'ClipForge',
      Accept: 'application/vnd.github+json'
    }
  })
  if (!response.ok) {
    throw new Error(`GitHub 回答了 ${response.status}`)
  }

  const body = (await response.json()) as {
    tag_name?: string
    assets?: { name?: string; browser_download_url?: string; size?: number }[]
  }
  const version = (body.tag_name ?? '').replace(/^v/, '')
  const wanted = binaryName()
  const asset = (body.assets ?? []).find((a) => a.name === wanted)
  if (!version || !asset?.browser_download_url) return null

  return {
    version,
    url: asset.browser_download_url,
    size: asset.size ?? 0
  }
}

/**
 * Puts a newer yt-dlp in place.
 *
 * The file is written next to the old one and moved over it, so a failed
 * download never leaves a half written binary behind.
 */
export async function installYtdlp(release: YtdlpRelease): Promise<string> {
  const response = await fetch(release.url, {
    headers: { 'User-Agent': 'ClipForge' }
  })
  if (!response.ok) {
    throw new Error(`下载失败：${response.status}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 100_000) {
    throw new Error('下载到的文件不像是 yt-dlp')
  }

  const target = updatedYtdlpPath()
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.new`
  writeFileSync(temp, bytes)
  if (process.platform !== 'win32') chmodSync(temp, 0o755)

  // Windows will not move a file over another one.
  try {
    unlinkSync(target)
  } catch {
    /* there was none */
  }
  renameSync(temp, target)

  return target
}

/**
 * Turns a version into the numbers it is made of.
 *
 * The versions are dates: 2026.11.10. Some of them carry a suffix after
 * the date, which is of no interest here.
 */
function versionParts(version: string): number[] {
  const found = /(\d{4})[.\-_](\d{1,2})(?:[.\-_](\d{1,2}))?/.exec(version)
  if (!found) return []
  return [Number(found[1]), Number(found[2]), Number(found[3] ?? 0)]
}

/** Whether a version is newer than another one. */
export function isNewer(candidate: string, current: string): boolean {
  const a = versionParts(candidate)
  const b = versionParts(current)
  if (a.length === 0 || b.length === 0) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}
