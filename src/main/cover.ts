import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { toMediaUrl } from './protocol'

/**
 * Keeps the picture of a video close by.
 *
 * The window may not load a picture from the internet, and the picture of
 * a video is of no use once the app is closed. It is fetched once and
 * kept in the user data folder, so the second time it costs nothing.
 */

const EXTENSIONS = ['jpg', 'png', 'webp']

function coverDir(): string {
  return join(app.getPath('userData'), 'covers')
}

/**
 * Fetches the picture of a video and gives back a link the window can
 * load. An empty string means there is no picture to show.
 */
export async function coverImage(url: string): Promise<string> {
  if (!url || !/^https?:/i.test(url)) return ''

  const key = createHash('sha1').update(url).digest('hex').slice(0, 16)
  const dir = coverDir()

  // A picture that was fetched before is used as it is.
  for (const ext of EXTENSIONS) {
    const cached = join(dir, `${key}.${ext}`)
    if (existsSync(cached)) return toMediaUrl(cached)
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ClipForge' }
    })
    if (!response.ok) return ''
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length < 1000) return ''

    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    const ext = type.includes('png')
      ? 'png'
      : type.includes('webp')
        ? 'webp'
        : 'jpg'

    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${key}.${ext}`)
    writeFileSync(file, bytes)
    return toMediaUrl(file)
  } catch {
    // A picture that cannot be fetched is not worth a message.
    return ''
  }
}
