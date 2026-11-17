/**
 * Finding the media a page holds.
 *
 * The generic extractor of yt-dlp reads a page for addresses that look
 * like media. A page that keeps its player in a JSON blob hides the
 * address: the slashes are escaped (`https:\/\/…`), so the address is not
 * there to be read. Such a page looks empty to the extractor, and the
 * download workspace has nothing to show.
 *
 * This reads the page itself and looks for those addresses as well.
 */

import { app, net } from 'electron'

/** A stream that was found in a page. */
export interface ScannedStream {
  /** The address of the stream itself. */
  url: string
  /** The name that was found with it. */
  title: string
}

/** What came of reading a page. */
export interface ScanResult {
  streams: ScannedStream[]
  /** Why the page could not be read; empty when it was. */
  error: string
  /** Whether the page was read at all. */
  read: boolean
}

/** The addresses that are worth looking for. */
const MEDIA =
  /https?:\/\/[^"'\\\s<>]+?\.(?:m3u8|mp4|webm)(?:\?[^"'\\\s<>]*)?/gi

/** The heading that gives a page its name. */
const HEADING = /<h[1-6][^>]*>([\s\S]{0,160}?)<\/h[1-6]>/gi

/** The name of the page itself. */
const TITLE = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i

/** The headers a browser sends when a page is opened. */
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Says what went wrong, in words that mean something.
 */
function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.message} ${err.cause ?? ''}` : String(err)
  if (/getaddrinfo|enotfound|name_not_resolved|could not resolve/i.test(text)) {
    return '域名解析不了'
  }
  if (/timeout|timed out|aborted/i.test(text)) {
    return '页面读超时'
  }
  if (/ECONNREFUSED|econnrefused/i.test(text)) {
    return '连接被拒绝'
  }
  if (/CERT|SSL|certificate/i.test(text)) {
    return '证书有问题'
  }
  return text.slice(0, 120)
}

/**
 * Fetches a page and hands back its text.
 *
 * Some servers answer a request without a browser's headers with an empty
 * page, so the headers are given. A page that does not answer at all must
 * not hold the workspace waiting, so the call is given a deadline, and a
 * second attempt is made when the first one fails.
 */
/**
 * Fetches a page the way a browser would.
 *
 * Chromium's own network stack is used where there is one: the sites
 * that sit behind a wall look at the fingerprint of the one who knocks,
 * and the plain one of Node is not a browser's. The plain one is kept as
 * a fallback, for the times the window is not up yet.
 */
async function request(url: string, timeoutMs: number): Promise<Response> {
  const options: RequestInit = {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  }
  if (app.isReady() && typeof net?.fetch === 'function') {
    return await net.fetch(url, options)
  }
  return await fetch(url, options)
}

async function fetchPage(url: string): Promise<{ html: string; error: string }> {
  let last = '连接失败'

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await request(url, 8000)
      if (!response.ok) {
        last = `HTTP ${response.status}`
        // A page that asks a browser to prove itself cannot be read.
        if (response.status === 403) break
        continue
      }
      const html = await response.text()
      if (!html.trim()) {
        last = '页面是空的'
        continue
      }
      return { html, error: '' }
    } catch (err) {
      const raw =
        err instanceof Error ? `${err.message} ${err.cause ?? ''}` : String(err)
      last = describeError(err)
      // A page that is not there at once is not worth trying again right
      // away; a timeout would only make the wait longer.
      if (!/getaddrinfo|enotfound|econnrefused|econnreset/i.test(raw)) break
    }
    if (attempt === 0) await delay(700)
  }

  return { html: '', error: last }
}

/**
 * Takes the text out of a piece of markup.
 */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The name of the page, without the name of the site behind it.
 */
function pageTitle(html: string): string {
  const found = TITLE.exec(html)
  if (!found) return ''
  const text = stripTags(found[1])
  // A title is often "the name - the name of the site".
  const cut = text.split(' - ')[0] ?? text
  return cut.trim()
}

/**
 * The heading that stands closest to a place in the page.
 *
 * A page with several players usually gives each of them a heading; the
 * one before the player is its name.
 */
function headingNear(html: string, at: number): string {
  const before = html.slice(Math.max(0, at - 2500), at)
  const found = [...before.matchAll(HEADING)]
  const last = found[found.length - 1]
  if (!last) return ''
  return stripTags(last[1] ?? '')
}

/**
 * The name of a stream, when the address carries one.
 */
function nameFromUrl(url: string): string {
  const file = url.split('/').pop()?.split('?')[0] ?? ''
  const cleaned = file
    .replace(/\.(m3u8|mp4|webm)$/i, '')
    .replace(/[-_+]+/g, ' ')
    .trim()
  return cleaned
}

/**
 * Looks for the media a page holds.
 *
 * The page is read the way a browser would see it: the escapes are taken
 * out first, so that an address that is hidden in a JSON blob is found.
 */
export async function scanPage(url: string): Promise<ScanResult> {
  const { html, error } = await fetchPage(url)
  if (!html) return { streams: [], error, read: false }
  const streams = findStreams(html)
  return {
    streams,
    error: streams.length > 0 ? '' : '页面里没有找到媒体地址',
    read: true
  }
}

/**
 * Looks for the media in the text of a page.
 */
export function findStreams(html: string): ScannedStream[] {
  if (!html) return []

  // The escapes are taken out before the addresses are looked for.
  const relaxed = html
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")

  const fallback = pageTitle(html)
  const streams: ScannedStream[] = []
  const seen = new Set<string>()

  MEDIA.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MEDIA.exec(relaxed)) !== null) {
    const media = match[0]
    if (seen.has(media)) continue
    seen.add(media)

    const heading = headingNear(relaxed, match.index)
    streams.push({
      url: media,
      title: heading || fallback || nameFromUrl(media)
    })
  }

  return streams
}
