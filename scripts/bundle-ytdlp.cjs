/**
 * Copies yt-dlp into `build/bin` so the packaged app can download videos
 * without asking the user to install anything.
 *
 * yt-dlp is looked up at runtime in this order:
 *   1. $CLIPFORGE_YTDLP (may carry arguments, e.g. "python -m yt_dlp")
 *   2. the path picked in the app's download workspace
 *   3. <resources>/bin (what this script produces)
 *   4. the system PATH
 *
 * Run `node scripts/bundle-ytdlp.cjs` before `npm run dist` to produce a
 * standalone installer. Without it the app falls back to whatever yt-dlp is
 * on the PATH, or asks the user where it is.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'build', 'bin')

function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, [bin], { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return null
  const first = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)
  return first ? first.trim() : null
}

function main() {
  const env = process.env.CLIPFORGE_YTDLP
  // The override may name a program with arguments; only the program
  // itself can be copied.
  const candidate = env ? env.trim().split(/\s+/)[0] : null
  const source =
    (candidate && fs.existsSync(candidate) && candidate) ||
    which(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

  if (!source) {
    console.error(
      '✗ yt-dlp not found. Download it from https://github.com/yt-dlp/yt-dlp/releases\n' +
        '  and either put it on the PATH or set CLIPFORGE_YTDLP to its path.'
    )
    process.exit(1)
  }

  fs.mkdirSync(OUT, { recursive: true })

  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  const dest = path.join(OUT, name)
  fs.copyFileSync(source, dest)

  const bytes = fs.statSync(dest).size
  console.log(`✓ bundled yt-dlp (${(bytes / 1024 / 1024).toFixed(1)} MB) into build/bin`)
}

main()
