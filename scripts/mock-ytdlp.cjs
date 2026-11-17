/**
 * A stand-in for yt-dlp.
 *
 * It answers the same calls the real binary does — the version, the
 * metadata dump and the download itself — so that the download workspace
 * can be exercised without a network connection.
 *
 *   CLIPFORGE_YTDLP="node scripts/mock-ytdlp.cjs" npm run dev
 *
 * The links it knows:
 *   https://mock/video      one video
 *   https://mock/playlist   three videos
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)

function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

function has(name) {
  return args.includes(name)
}

const url = args[args.length - 1] ?? ''

if (has('--version')) {
  process.stdout.write('2026.01.01\n')
  process.exit(0)
}

/* --- the metadata ------------------------------------------------------- */

const FORMATS = [
  {
    format_id: '137',
    ext: 'mp4',
    width: 1920,
    height: 1080,
    fps: 60,
    filesize: 47185920,
    vcodec: 'avc1',
    acodec: 'none'
  },
  {
    format_id: '136',
    ext: 'mp4',
    width: 1280,
    height: 720,
    fps: 30,
    filesize: 20971520,
    vcodec: 'avc1',
    acodec: 'none'
  },
  {
    format_id: '248',
    ext: 'webm',
    width: 1920,
    height: 1080,
    fps: 60,
    filesize: 39845888,
    vcodec: 'vp9',
    acodec: 'none'
  },
  {
    format_id: '140',
    ext: 'm4a',
    abr: 129,
    vcodec: 'none',
    acodec: 'mp4a'
  },
  {
    format_id: '251',
    ext: 'webm',
    abr: 130,
    vcodec: 'none',
    acodec: 'opus'
  }
]

function video(index) {
  return {
    title: `示例视频标题 ${index}`,
    thumbnail: '',
    duration: 133,
    extractor: 'MockSite',
    formats: FORMATS
  }
}

function flatEntry(index) {
  return {
    id: `e${index}`,
    title: `示例视频标题 ${index}`,
    thumbnail: '',
    duration: 100 + index * 30,
    url: `https://mock/video/${index}`
  }
}

if (has('--dump-single-json')) {
  const isList = url.includes('playlist')

  // A page the extractor cannot make sense of: the stream is hidden in a
  // JSON blob, so nothing is found.
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    process.stderr.write(
      'ERROR: Unable to extract any media from the page\n'
    )
    process.exit(1)
  }

  // A page with several entries: only the names are known.
  if (isList && has('--flat-playlist')) {
    process.stdout.write(
      JSON.stringify({
        title: '示例列表',
        extractor: 'MockSite',
        entries: [flatEntry(1), flatEntry(2), flatEntry(3)]
      })
    )
    process.exit(0)
  }

  // One entry of a list.
  const wanted = flag('--playlist-items')
  if (wanted) {
    const at = Math.max(1, Number.parseInt(wanted, 10) || 1)
    const picked = video(at)
    process.stdout.write(JSON.stringify(picked))
    process.exit(0)
  }

  // A link that holds one video, whose details were left out the way
  // --flat-playlist leaves a lone video.
  if (url.includes('flat') && has('--flat-playlist')) {
    process.stdout.write(
      JSON.stringify({
        title: '示例视频标题 1',
        thumbnail: '',
        duration: 133,
        extractor: 'MockSite'
      })
    )
    process.exit(0)
  }

  const single = isList ? video(1) : video(1)
  process.stdout.write(JSON.stringify(single))
  process.exit(0)
}

/* --- the download ------------------------------------------------------- */

// Links that fail, so that the way a failure is reported can be looked at.
if (url.includes('fail-auth')) {
  process.stderr.write(
    "ERROR: [MockSite] abc: Sign in to confirm you're not a bot. " +
      'Use --cookies-from-browser or --cookies for the authentication.\n'
  )
  process.exit(1)
}
if (url.includes('fail-old')) {
  process.stderr.write(
    'ERROR: [MockSite] abc: Unable to extract NSig sig param; please report this issue\n'
  )
  process.exit(1)
}
if (url.includes('fail-net')) {
  process.stderr.write('ERROR: unable to download video data: Connection reset by peer\n')
  process.exit(1)
}

// A picture and a sound are two files: they come one after the other.
const wanted = flag('-f') ?? ''
const streams = wanted.includes('+') ? 2 : 1
const template = flag('--progress-template') ?? ''
const outTemplate = flag('-o') ?? '%(title)s.%(ext)s'

const ROUNDS = [
  [12, 47, 83, 100],
  [20, 60, 100]
]

let round = 0
let index = 0

const timer = setInterval(() => {
  const steps = ROUNDS[Math.min(round, ROUNDS.length - 1)]
  const pct = steps[Math.min(index, steps.length - 1)]
  index += 1

  const line = template
    .replace('%(progress._percent_str)s', `${pct.toFixed(1)}%`)
    .replace('%(progress._speed_str)s', '1.20MiB/s')
    .replace('%(progress._eta_str)s', '00:00:12')
    .replace('%(progress._total_bytes_str)s', '45.20MiB')
    .replace('%(progress._downloaded_bytes_str)s', `${((pct / 100) * 45.2).toFixed(2)}MiB`)
  process.stdout.write(line + '\n')

  if (pct >= 100) {
    index = 0
    round += 1
    if (round < streams) return

    clearInterval(timer)
    const name = outTemplate
      .replace('%(title)s', '示例视频标题')
      .replace('%(ext)s', 'mp4')
    const file = path.isAbsolute(name) ? name : path.join(process.cwd(), name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // A real file, so that what came down can be read back.
    const sample = path.join(__dirname, '..', 'testmedia', 'clip-b.mp4')
    if (fs.existsSync(sample)) {
      fs.copyFileSync(sample, file)
    } else {
      fs.writeFileSync(file, 'mock video')
    }
    process.stdout.write(file + '\n')
    process.exit(0)
  }
}, 120)
