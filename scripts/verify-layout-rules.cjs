/**
 * Checks the rules the timeline layout follows:
 *   1. a clip that is dropped on a busy place lands in the free place
 *      closest to it
 *   2. a clip that grows pushes its neighbour along
 *   3. the zoom covers both ends of the timeline
 *
 * The rules live in the renderer, so the module is bundled with esbuild and
 * the checks run in plain node.
 *
 *   node scripts/verify-layout-rules.cjs
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let failures = 0

function check(label, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-6
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? ` — ${actual}` : ` — ${actual} (expected ${expected})`}`)
}

function checkTrue(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}

async function loadRules() {
  const out = path.join(os.tmpdir(), `clipforge-layout-${process.pid}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'renderer', 'engine', 'timeline.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@shared': path.join(ROOT, 'src', 'shared') },
    outfile: out,
    logLevel: 'error'
  })
  const module = await import(`file://${out.replace(/\\/g, '/')}`)
  fs.unlinkSync(out)
  return module
}

async function run() {
  const { findFreeSlot, pushClipsApart, maxZoomFor, sliderToZoom, zoomToSlider } =
    await loadRules()

  // A lane holding A: 0-8s and B: 10-20s.
  const spans = [
    { start: 0, end: 8, clipId: 'A' },
    { start: 10, end: 20, clipId: 'B' }
  ]

  console.log('\n▶ a free place is used as it is')
  check('a free place stays', findFreeSlot(spans, 20, 5), 20)
  check('touching the next clip is not overlapping', findFreeSlot(spans, 8, 2), 8)

  console.log('\n▶ a busy place is left')
  check('a clip that does not fit in the gap slides past', findFreeSlot(spans, 6, 5), 20)
  check('a clip that fits in the gap takes it', findFreeSlot(spans, 9, 2), 8)
  check('a clip dropped on a clip goes behind it', findFreeSlot(spans, 11, 3), 20)
  check('the closer gap in front is taken', findFreeSlot([{ start: 10, end: 20, clipId: 'A' }], 12, 3), 7)

  console.log('\n▶ a lane that is packed solid')
  check(
    'the clip waits behind everything',
    findFreeSlot(
      [
        { start: 0, end: 10, clipId: 'A' },
        { start: 10, end: 20, clipId: 'B' }
      ],
      5,
      12
    ),
    20
  )
  check('a place is never negative', findFreeSlot(spans, -5, 4), 20)

  console.log('\n▶ a clip that grows pushes its neighbour')
  const clips = [
    { id: 'a', start: 0, duration: 5 },
    { id: 'b', start: 10, duration: 5 },
    { id: 'c', start: 15, duration: 5 }
  ]
  clips[0].duration = 12
  pushClipsApart(clips, clips[0].start)
  check('the neighbour moved along', clips[1].start, 12)
  check('the second neighbour moved along', clips[2].start, 17)

  const shrink = [
    { id: 'a', start: 0, duration: 10 },
    { id: 'b', start: 12, duration: 5 }
  ]
  shrink[0].duration = 4
  pushClipsApart(shrink, shrink[0].start)
  check('a clip that shrinks leaves the gap alone', shrink[1].start, 12)

  console.log('\n▶ the zoom')
  const max = maxZoomFor(60)
  check('the slider round trip', zoomToSlider(sliderToZoom(0.5, max), max), 0.5)
  checkTrue('the zoom goes far in', max > 10000, `${max.toFixed(0)} px/s`)
  checkTrue(
    'a long project still gets a usable zoom',
    maxZoomFor(3600) > 1000,
    `${maxZoomFor(3600).toFixed(0)} px/s`
  )
  console.log(`  a 60s project: ${sliderToZoom(0, max).toFixed(2)} … ${max.toFixed(0)} px/s`)
  console.log(`  an hour:      ${sliderToZoom(0, maxZoomFor(3600)).toFixed(2)} … ${maxZoomFor(3600).toFixed(0)} px/s`)

  console.log(failures === 0 ? '\n✅ all checks passed' : `\n❌ ${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
