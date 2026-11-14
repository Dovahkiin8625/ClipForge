import { protocol } from 'electron'
import { createReadStream, statSync } from 'fs'
import { Readable } from 'stream'

/**
 * Serves local media to the renderer over `clipforge://`.
 *
 * The renderer needs byte-range support: `<video>` elements issue Range
 * requests whenever they seek, and Chromium refuses to scrub a video whose
 * server does not honour them.
 */

const SCHEME = 'clipforge'

/**
 * Paths are base64url-encoded into the URL.
 *
 * Windows paths (`C:\...`), UNC paths and non-ASCII characters all survive
 * that intact, whereas percent-encoding collides with the URL parser's own
 * treatment of `:` in a path segment.
 */
function decodePath(rawUrl: string): string {
  const url = new URL(rawUrl)
  const encoded = url.pathname.replace(/^\//, '')
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Declares the custom scheme's privileges.
 *
 * Electron requires this to happen *before* the app becomes ready, so it is
 * kept separate from the handler registration below.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Without this the renderer cannot fetch media from the scheme,
        // and `<video crossorigin="anonymous">` would be silenced.
        corsEnabled: true,
        stream: true,
        bypassCSP: false
      }
    }
  ])
}

/** Installs the handler that serves local media. Call after the app is ready. */
export function registerMediaProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const filePath = decodePath(request.url)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('Not a file', { status: 404 })

    const total = stat.size
    const rangeHeader = request.headers.get('range')

    const headers = new Headers({
      'Content-Type': mimeFor(filePath),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      // The renderer loads media with `crossorigin="anonymous"` so that the
      // element can be routed through Web Audio — which requires a CORS-clean
      // response or the element is silenced.
      'Access-Control-Allow-Origin': '*'
    })

    if (!rangeHeader) {
      headers.set('Content-Length', String(total))
      return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
        status: 200,
        headers
      })
    }

    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (!match) {
      headers.set('Content-Range', `bytes */${total}`)
      return new Response(null, { status: 416, headers })
    }

    const [, startRaw, endRaw] = match
    let start: number
    let end: number
    if (startRaw === '') {
      // Suffix range: `bytes=-N` means the last N bytes.
      const suffix = Number(endRaw)
      start = Math.max(0, total - suffix)
      end = total - 1
    } else {
      start = Number(startRaw)
      end = endRaw === '' ? total - 1 : Math.min(Number(endRaw), total - 1)
    }
    if (Number.isNaN(start) || start > end || start >= total) {
      headers.set('Content-Range', `bytes */${total}`)
      return new Response(null, { status: 416, headers })
    }

    headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
    headers.set('Content-Length', String(end - start + 1))

    const stream = createReadStream(filePath, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers })
  })
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

/** Converts an absolute path into a URL the renderer can load. */
export function toMediaUrl(filePath: string): string {
  const encoded = Buffer.from(filePath, 'utf8').toString('base64url')
  return `${SCHEME}://media/${encoded}`
}

