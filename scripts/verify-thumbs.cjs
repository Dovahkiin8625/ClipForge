/**
 * Checks that the thumbnails of a big recording arrive quickly.
 *
 * A large file used to be decoded from beginning to end just to pick sixty
 * frames out of it, which left the library card and the filmstrip empty for
 * many seconds. The sheet is now baked from the key frames only, and the
 * card gets a single picture of its own long before that.
 *
 *   npm run build && npx electron scripts/verify-thumbs.cjs
 */
const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BIG = path.join(ROOT, 'testmedia', 'big.mp4')
/** A recording that is encoded the way a camera or a download encodes one. */
const REAL = path.join(ROOT, 'testmedia', 'real.mp4')
const SMALL = path.join(ROOT, 'testmedia', 'clip-a.mp4')

/** A big recording has to be on screen in a moment, not in a minute. */
const POSTER_BUDGET_MS = 3000
const SHEET_BUDGET_MS = 8000

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'}${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Imports a file and measures how long its picture and its sheet take. */
function measure(win, file) {
  return win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const imported = await window.clipforge.media.importPaths(${JSON.stringify([file])})
      const asset = imported[0]
      const started = Date.now()
      store.getState().addAssets(imported)

      // The picture of the card.
      let posterAt = -1
      while (Date.now() - started < 30000) {
        await new Promise(r => setTimeout(r, 20))
        if (window.__clipforgeMedia.poster(asset.id)) {
          posterAt = Date.now() - started
          break
        }
      }

      // The sheet of frames.
      let sheetAt = -1
      while (Date.now() - started < 30000) {
        await new Promise(r => setTimeout(r, 20))
        if (window.__clipforgeMedia.sprite(asset.id)) {
          sheetAt = Date.now() - started
          break
        }
      }

      const sheet = window.__clipforgeMedia.sprite(asset.id)
      return {
        duration: asset.duration,
        width: asset.width,
        height: asset.height,
        posterAt,
        sheetAt,
        poster: window.__clipforgeMedia.poster(asset.id),
        sheet: sheet && {
          cols: sheet.cols,
          rows: sheet.rows,
          count: sheet.count,
          frameWidth: sheet.frameWidth,
          frameHeight: sheet.frameHeight,
          startTime: sheet.startTime,
          interval: sheet.interval
        }
      }
    })()`
  )
}

/**
 * Makes a long recording to test with.
 *
 * A five minute file with a key frame every two seconds is enough to tell a
 * quick sheet from a slow one.
 */
function ensureRecording(file, seconds) {
  if (fs.existsSync(file)) return true
  const bin = process.env.CLIPFORGE_FFMPEG || 'ffmpeg'
  console.log(`  (making a ${seconds / 60} minute recording for the test …)`)
  const result = spawnSync(
    bin,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(seconds),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-shortest',
      file
    ],
    { stdio: 'inherit' }
  )
  return result.status === 0 && fs.existsSync(file)
}

async function run() {
  require(path.join(ROOT, 'out', 'main', 'index.js'))
  await app.whenReady()
  await delay(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('❌ no window was created')
    app.exit(1)
  }

  if (!ensureRecording(BIG, 300)) {
    console.error(`❌ could not make a test recording at ${BIG}`)
    app.exit(1)
  }

  /* --- the long recordings --------------------------------------------- */
  for (const file of [BIG, REAL]) {
    if (!fs.existsSync(file)) continue
    const name = path.basename(file)
    console.log(`\n▶ ${name}`)
    const result = await measure(win, file)

    console.log(
      `  ${(result.duration / 60).toFixed(1)} min, ${result.width}×${result.height}, ` +
        `picture ${result.posterAt}ms, sheet ${result.sheetAt}ms`
    )
    check(
      'the card shows a picture quickly',
      result.posterAt >= 0 && result.posterAt < POSTER_BUDGET_MS,
      `${result.posterAt}ms`
    )
    check(
      'the filmstrip is baked quickly',
      result.sheetAt >= 0 && result.sheetAt < SHEET_BUDGET_MS,
      `${result.sheetAt}ms`
    )
    check('the picture has a URL', typeof result.poster === 'string' && result.poster.length > 0)

    const sheet = result.sheet
    check(
      'the sheet is a full grid',
      !!sheet && sheet.cols * sheet.rows === sheet.count,
      JSON.stringify(sheet)
    )

    // The frame of the sheet has to have the shape of the recording, or the
    // timeline reads the wrong frames out of it.
    const expectedHeight = Math.round((160 * result.height) / result.width / 2) * 2
    check(
      'the frame of the sheet has the shape of the recording',
      !!sheet && Math.abs(sheet.frameHeight - expectedHeight) <= 2,
      sheet ? `${sheet.frameWidth}×${sheet.frameHeight}, expected 160×${expectedHeight}` : 'no sheet'
    )

    // The frames have to be spread over the whole recording.
    const expectedInterval = result.duration / sheet.count
    check(
      'the frames are spread over the whole recording',
      !!sheet && Math.abs(sheet.interval - expectedInterval) < expectedInterval * 0.1,
      sheet ? `every ${sheet.interval.toFixed(2)}s` : 'no sheet'
    )
  }

  /* --- a small recording still works ---------------------------------- */
  console.log('\n▶ a short recording')
  const small = await measure(win, SMALL)
  console.log(`  sheet ${small.sheetAt}ms`)
  check('the sheet of a short recording arrives', small.sheetAt >= 0, `${small.sheetAt}ms`)
  check(
    'the sheet is a full grid',
    !!small.sheet && small.sheet.cols * small.sheet.rows === small.sheet.count,
    JSON.stringify(small.sheet)
  )

  const decoded = await win.webContents.executeJavaScript(
    `(async () => {
      const sheet = window.__clipforgeMedia.sprite(
        Object.keys(window.__clipforgeEditor.getState().project.assets)
          .map(id => window.__clipforgeEditor.getState().project.assets[id])
          .find(a => a.path === ${JSON.stringify(SMALL)}).id
      )
      const img = window.__clipforgeMedia.image(sheet.url)
      if (img && !img.complete) {
        await new Promise(r => { img.onload = r; img.onerror = r })
      }
      return !!(img && img.complete && img.naturalWidth > 0)
    })()`
  )
  check('the sheet is decoded by the renderer', decoded)

  /* --- what the user sees ---------------------------------------------- */
  const shots = path.join(ROOT, 'shots')
  fs.mkdirSync(shots, { recursive: true })
  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const s = store.getState()
      const asset = Object.values(s.project.assets).find(a => a.path === ${JSON.stringify(BIG)})
      const track = s.project.tracks.find(t => t.kind === 'video')
      s.insertClip(asset.id, track.id, 0)
      await new Promise(r => setTimeout(r, 1200))
      return true
    })()`
  )
  await delay(800)
  const image = await win.capturePage()
  fs.writeFileSync(path.join(shots, '10-thumbnails.png'), image.toPNG())
  console.log('\n  📸 shots/10-thumbnails.png')

  console.log(failures === 0 ? '\n✅ all checks passed' : `\n❌ ${failures} check(s) failed`)
  app.exit(failures === 0 ? 0 : 1)
}

app.on('window-all-closed', () => {})
run().catch((err) => {
  console.error(err)
  app.exit(1)
})
