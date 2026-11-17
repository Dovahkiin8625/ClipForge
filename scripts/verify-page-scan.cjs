/**
 * Checks the page scanner against a page that was fetched by hand.
 *
 * A page that keeps its players in JSON blobs hides the address of the
 * stream in escaped slashes, and the generic extractor of yt-dlp does not
 * see those. The scanner has to find them.
 *
 *   npx esbuild src/main/pageScan.ts --bundle --format=cjs --outfile=out/page-scan.cjs
 *   node scripts/verify-page-scan.cjs <page.html>
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const built = path.join(ROOT, 'out', 'page-scan.cjs')

if (!fs.existsSync(built)) {
  console.error('❌ out/page-scan.cjs is missing — build it first')
  process.exit(1)
}

const { findStreams } = require(built)

const file =
  process.argv[2] || path.join(ROOT, 'scripts', 'fixtures', 'page-with-players.html')
if (!fs.existsSync(file)) {
  console.error(`❌ the page to read is missing: ${file}`)
  process.exit(1)
}

const html = fs.readFileSync(file, 'utf8')
const streams = findStreams(html)

console.log('streams found:', streams.length)
for (const s of streams) {
  console.log(`  ${s.title}`)
  console.log(`    ${s.url}`)
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

check('every stream is found', streams.length === 3, `${streams.length} found`)
check(
  'the streams are the hidden ones',
  streams.every((s) => s.url.includes('.m3u8')),
  streams[0]?.url ?? ''
)
check(
  'the streams carry a name',
  streams.every((s) => s.title.length > 0),
  streams[0]?.title ?? ''
)
check(
  'the same stream is not twice',
  new Set(streams.map((s) => s.url)).size === streams.length
)

console.log('')
process.exit(failures ? 1 : 0)
