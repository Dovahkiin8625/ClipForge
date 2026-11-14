/**
 * Copies FFmpeg into `build/bin` so the packaged app can be self-contained.
 *
 * FFmpeg is looked up at runtime in this order:
 *   1. $CLIPFORGE_FFMPEG / $CLIPFORGE_FFPROBE
 *   2. <resources>/bin (what this script produces)
 *   3. the system PATH
 *
 * Run `node scripts/bundle-ffmpeg.cjs` before `npm run dist` to produce a
 * standalone installer. Without it the app uses whatever FFmpeg is on PATH.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'build', 'bin')

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, [bin], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  const first = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim())
  return first ? first.trim() : null
}

function main() {
  const ffmpeg = process.env.CLIPFORGE_FFMPEG || which('ffmpeg')
  const ffprobe = process.env.CLIPFORGE_FFPROBE || which('ffprobe')

  if (!ffmpeg || !ffprobe) {
    console.error('✗ FFmpeg not found on PATH. Install it, or set CLIPFORGE_FFMPEG.')
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })

  const files = [ffmpeg, ffprobe]
  // A shared build keeps its codecs in sibling DLLs — copy those too.
  const dir = path.dirname(ffmpeg)
  for (const entry of fs.readdirSync(dir)) {
    if (/^(av|sw|postproc|lib).*\.dll$/i.test(entry)) {
      files.push(path.join(dir, entry))
    }
  }

  let bytes = 0
  for (const file of files) {
    const dest = path.join(OUT, path.basename(file))
    fs.copyFileSync(file, dest)
    bytes += fs.statSync(dest).size
  }

  console.log(`✓ bundled ${files.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) into build/bin`)
}

main()
