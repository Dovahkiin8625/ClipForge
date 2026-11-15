/**
 * A stand-in for yt-dlp.
 *
 * It answers the same calls the real binary does — the version, the
 * metadata dump and the download itself — so that the download workspace
 * can be exercised without a network connection.
 *
 *   CLIPFORGE_YTDLP="node scripts/mock-ytdlp.cjs" npm run dev
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)

function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

if (args.includes('--version')) {
  process.stdout.write('2026.01.01\n')
  process.exit(0)
}

if (args.includes('--dump-single-json')) {
  const url = args[args.length - 1]
  process.stdout.write(
    JSON.stringify({
      title: '示例视频标题',
      thumbnail: '',
      duration: 133,
      extractor: 'MockSite',
      formats: [
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
          format_id: '140',
          ext: 'm4a',
          vcodec: 'none',
          acodec: 'mp4a'
        }
      ]
    })
  )
  process.exit(0)
}

// The download itself: progress lines, then the finished file.
const template = flag('--progress-template') ?? ''
const outTemplate = flag('-o') ?? '%(title)s.%(ext)s'
const url = args[args.length - 1]

const steps = [12, 47, 83, 100]
let index = 0

const timer = setInterval(() => {
  const pct = steps[Math.min(index, steps.length - 1)]
  index += 1
  const line = template
    .replace('%(progress._percent_str)s', `${pct.toFixed(1)}%`)
    .replace('%(progress._speed_str)s', '1.20MiB/s')
    .replace('%(progress._eta_str)s', '00:00:12')
    .replace('%(progress._total_bytes_str)s', '45.20MiB')
    .replace('%(progress._downloaded_bytes_str)s', `${(pct / 100) * 45.2}MiB`)
  process.stdout.write(line + '\n')

  if (pct >= 100) {
    clearInterval(timer)
    const name = outTemplate
      .replace('%(title)s', '示例视频标题')
      .replace('%(ext)s', 'mp4')
    const file = path.isAbsolute(name) ? name : path.join(process.cwd(), name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'mock video')
    process.stdout.write(file + '\n')
    process.exit(0)
  }
}, 120)
