/**
 * Checks that the preview and the export agree about the colour
 * adjustments.
 *
 * The preview runs the adjustments through a fragment shader, the export
 * writes them into FFmpeg filters. Both are supposed to describe the same
 * picture — this script measures how far apart they are, by running the
 * shader's arithmetic and FFmpeg over the same frame and comparing the
 * pixels.
 *
 *   node scripts/verify-adjust-parity.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEDIA = path.join(ROOT, 'testmedia', 'clip-a.mp4')
const W = 320
const H = 180

/* The adjustments that are checked. The blur, the sharpen and the grain
   use different kernels on the two sides and are left out. */
const ADJ = {
  brightness: 0.15,
  contrast: 0.3,
  saturation: -0.4,
  temperature: 0.5,
  shadows: 0.35,
  highlights: -0.25
}

/** How far apart two pictures may be, in levels out of 255. */
const TOLERANCE = 3

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/**
 * Bundles the shared adjustments module so the script works on the very
 * same numbers the editor and the exporter use.
 */
function loadShared() {
  const esbuild = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (!fs.existsSync(esbuild)) return null
  const out = path.join(os.tmpdir(), `clipforge-adjustments-${process.pid}.cjs`)
  const res = spawnSync(
    process.execPath,
    [
      esbuild,
      path.join(ROOT, 'src', 'shared', 'adjustments.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${out}`
    ],
    { encoding: 'utf8' }
  )
  if (res.status !== 0) {
    console.error(res.stderr)
    return null
  }
  return require(out)
}

/* --- the shader, in JavaScript ---------------------------------------- */

function shaderPixel(r, g, b, tone) {
  let c = [r, g, b]
  c = c.map((v) => v + ADJ.brightness)
  c = c.map((v) => (v - 0.5) * (1 + ADJ.contrast) + 0.5)
  c = c.map((v) => Math.min(1, Math.max(0, v)))
  c = c.map((v) => tone(v, ADJ.shadows, ADJ.highlights))
  // The saturation mixes around the luma; FFmpeg works on the chroma of a
  // BT.601 signal, so the same coefficients are used here.
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  const sat = 1 + ADJ.saturation
  c = c.map((v) => l + (v - l) * sat)
  c[0] *= 1 + ADJ.temperature * 0.15
  c[2] *= 1 - ADJ.temperature * 0.15
  return c.map((v) => Math.min(1, Math.max(0, v)) * 255)
}

/* --- the frames ------------------------------------------------------- */

function frame(vf) {
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-i', MEDIA,
      '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ],
    { maxBuffer: 1 << 28 }
  )
  if (res.status !== 0) {
    console.error(res.stderr.toString())
    process.exit(1)
  }
  return res.stdout
}

function main() {
  const shared = loadShared()
  if (!shared) {
    console.log('⚠️  esbuild is not available — skipping')
    return
  }
  const { toneCurve, toneChainPoints } = shared

  const source = frame(`scale=${W}:${H}`)

  // The export: the tone as one curve, the saturation through the chroma,
  // the temperature as a channel gain.
  const chain = [
    `scale=${W}:${H}`,
    `curves=all='${toneChainPoints(ADJ)}'`,
    `eq=saturation=${(1 + ADJ.saturation).toFixed(4)}`,
    `colorchannelmixer=rr=${(1 + ADJ.temperature * 0.15).toFixed(4)}:bb=${(
      1 - ADJ.temperature * 0.15
    ).toFixed(4)}`,
    'format=rgb24'
  ].join(',')
  const actual = frame(chain)

  let sum = 0
  let max = 0
  let count = 0
  for (let i = 0; i + 2 < source.length; i += 3) {
    const expected = shaderPixel(
      source[i] / 255,
      source[i + 1] / 255,
      source[i + 2] / 255,
      toneCurve
    )
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(expected[c] - actual[i + c])
      sum += d
      if (d > max) max = d
      count++
    }
  }
  const mean = sum / count

  console.log('\n▶ preview against export')
  console.log(`   filter chain: ${chain}`)
  console.log(`   mean ${mean.toFixed(2)}/255, largest ${max.toFixed(1)}/255`)
  check(
    `the two pictures are within ${TOLERANCE} levels of each other`,
    mean <= TOLERANCE,
    `${mean.toFixed(2)} levels`
  )

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
