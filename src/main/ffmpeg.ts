import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'

/**
 * Locates the ffmpeg/ffprobe binaries.
 *
 * Resolution order:
 *   1. Explicit environment override (CLIPFORGE_FFMPEG / CLIPFORGE_FFPROBE)
 *   2. Binaries shipped next to the packaged app
 *   3. Binaries on the system PATH
 *   4. The `ffmpeg-static` / `ffprobe-static` npm packages
 */

function which(bin: string): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, [bin], { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return null
  const first = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)
  return first ? first.trim() : null
}

function staticPackage(name: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(name) as string | { path?: string }
    const p = typeof mod === 'string' ? mod : mod?.path
    return p && existsSync(p) ? p : null
  } catch {
    return null
  }
}

function resolveBin(kind: 'ffmpeg' | 'ffprobe'): string | null {
  const envKey = kind === 'ffmpeg' ? 'CLIPFORGE_FFMPEG' : 'CLIPFORGE_FFPROBE'
  const env = process.env[envKey]
  if (env && existsSync(env)) return env

  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'bin', kind === 'ffmpeg' ? 'ffmpeg.exe' : 'ffprobe.exe')
    if (existsSync(bundled)) return bundled
  }

  const names = kind === 'ffmpeg' ? ['ffmpeg', 'ffmpeg.exe'] : ['ffprobe', 'ffprobe.exe']
  const onPath = names.map((n) => which(n)).find((p): p is string => !!p)
  if (onPath) return onPath

  return staticPackage(kind === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static')
}

export const ffmpegPath = (): string | null => resolveBin('ffmpeg')
export const ffprobePath = (): string | null => resolveBin('ffprobe')

export function ffmpegVersion(): string {
  const bin = ffmpegPath()
  if (!bin) return 'not found'
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8' })
  return (r.stdout ?? '').split(/\r?\n/)[0] ?? 'unknown'
}
