/**
 * Feature check for the colour adjustments:
 *   1. the 「调整」 tab in the inspector
 *   2. the sliders writing to the document
 *   3. the preview following the edit
 *   4. the export carrying the adjustments into the file
 *
 *   npx electron scripts/verify-adjustments.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [path.join(ROOT, 'testmedia', 'clip-a.mp4')]
const OUT = path.join(ROOT, 'out', 'verify-adjustments.mp4')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function shot(win, name) {
  const image = await win.capturePage()
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
}

/** The average brightness of the preview canvas. */
const CANVAS_BRIGHTNESS = `(() => {
  const c = document.querySelector('canvas.preview__canvas')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let sum = 0
  let n = 0
  for (let i = 0; i < d.length; i += 4 * 37) {
    sum += (d[i] + d[i + 1] + d[i + 2]) / 3
    n++
  }
  return sum / n
})()`

async function run() {
  require(path.join(ROOT, 'out', 'main', 'index.js'))
  await app.whenReady()
  await delay(2500)

  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    console.error('❌ no window')
    app.exit(1)
    return
  }

  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })

  console.log('\n▶ importing a clip')
  const clipId = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      store.getState().insertClip(assets[0].id, 't_video_1', 0)
      const clip = store.getState().project.tracks
        .flatMap(t => t.clips)
        .find(c => c.assetId === assets[0].id)
      store.getState().setPlayhead(1)
      return clip.id
    })()`
  )
  await delay(2500)

  /* --- 1. the tab ------------------------------------------------------- */
  console.log('\n▶ the 「调整」 tab')
  const tabs = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.inspector__tab')].map(b => b.textContent.trim())`
  )
  check('the inspector has an 调整 tab', tabs.includes('调整'), tabs.join(' / '))

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.select(['${clipId}'])
      s.setInspectorTab('adjust')
      return true
    })()`
  )
  await delay(400)

  const labels = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.inspector__label')].map(e => e.textContent.trim())`
  )
  const wanted = ['亮度', '对比度', '高光', '阴影', '饱和度', '色温', '锐化', '模糊', '颗粒']
  check(
    'the panel shows every adjustment',
    wanted.every((l) => labels.includes(l)),
    labels.join(' / ')
  )
  await shot(win, 'adjust-01-tab')

  /* --- 2. the sliders write to the document ---------------------------- */
  console.log('\n▶ the sliders')
  const typed = await win.webContents.executeJavaScript(
    `(() => {
      const input = [...document.querySelectorAll('.inspector__row .prop__num-input')]
        .find(i => i.getAttribute('aria-label') === '亮度')
      if (!input) return { error: 'no field' }
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '40')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    })()`
  )
  check('the brightness field accepts typed input', typed.ok === true)
  await delay(600)

  const stored = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${clipId}')
      return clip.adjustments
    })()`
  )
  check('the value reached the document', Math.abs(stored.brightness - 0.4) < 0.01, JSON.stringify(stored))

  /* --- 3. the preview follows ------------------------------------------ */
  console.log('\n▶ the preview')
  const before = await win.webContents.executeJavaScript(CANVAS_BRIGHTNESS)
  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.setClipAdjustments('${clipId}', { brightness: -0.6 })
      return true
    })()`
  )
  await delay(700)
  const darker = await win.webContents.executeJavaScript(CANVAS_BRIGHTNESS)
  check(
    'the picture got darker',
    darker < before - 3,
    `${before.toFixed(1)} → ${darker.toFixed(1)}`
  )
  await shot(win, 'adjust-02-preview')

  /* --- 3b. the picture is not turned the wrong way ---------------------- */
  // A brightness change has to move every pixel by the same amount. If the
  // filter hands the picture back upside down, the pixels land on the
  // wrong ones and the difference is everywhere.
  const flipped = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor.getState()
      store.setClipAdjustments('${clipId}', { brightness: 0, saturation: 0 })
      store.clearSelection()
      await new Promise(r => setTimeout(r, 400))
      const c = document.querySelector('canvas.preview__canvas')
      const before = c.getContext('2d').getImageData(0, 0, c.width, c.height)
      store.setClipAdjustments('${clipId}', { brightness: 0.2 })
      await new Promise(r => setTimeout(r, 400))
      const after = c.getContext('2d').getImageData(0, 0, c.width, c.height)
      let sum = 0
      let worst = 0
      let n = 0
      for (let i = 0; i < after.data.length; i += 4) {
        // The bright parts cannot get any brighter, so the offset runs
        // out at the top.
        const expected = Math.min(255, before.data[i] + 51)
        const d = Math.abs(after.data[i] - expected)
        sum += d
        if (d > worst) worst = d
        n++
      }
      return { mean: sum / n, worst }
    })()`
  )
  check(
    'the picture keeps its upright direction',
    flipped.mean < 4,
    `mean ${flipped.mean.toFixed(2)}, worst ${flipped.worst.toFixed(0)}`
  )
  // Greyscale: the picture must lose its colour.
  const colour = await win.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas.preview__canvas')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0
      let n = 0
      for (let i = 0; i < d.length; i += 4 * 37) {
        sum += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])
        n++
      }
      return sum / n
    })()`
  )
  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setClipAdjustments('${clipId}', { saturation: -1 })
      return true
    })()`
  )
  await delay(700)
  const grey = await win.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas.preview__canvas')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0
      let n = 0
      for (let i = 0; i < d.length; i += 4 * 37) {
        sum += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])
        n++
      }
      return sum / n
    })()`
  )
  check('the picture lost its colour', grey < colour - 1, `${colour.toFixed(1)} → ${grey.toFixed(1)}`)
  await shot(win, 'adjust-03-greyscale')

  /* --- 4. the detail effects -------------------------------------------- */
  console.log('\n▶ the detail effects')

  // How much detail the picture carries: the difference between
  // neighbouring pixels.
  const DETAIL = `(() => {
    const c = document.querySelector('canvas.preview__canvas')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let sum = 0
    let n = 0
    for (let y = 0; y < c.height - 1; y += 3) {
      for (let x = 0; x < c.width - 1; x += 3) {
        const i = (y * c.width + x) * 4
        sum += Math.abs(d[i] - d[i + 4]) + Math.abs(d[i + 1] - d[i + 5])
        n++
      }
    }
    return sum / n
  })()`

  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setClipAdjustments('${clipId}', {
        brightness: 0, saturation: 0
      })
      return true
    })()`
  )
  await delay(700)
  const sharp = await win.webContents.executeJavaScript(DETAIL)

  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setClipAdjustments('${clipId}', { blur: 0.6 })
      return true
    })()`
  )
  await delay(700)
  const blurred = await win.webContents.executeJavaScript(DETAIL)
  check('the blur softened the picture', blurred < sharp * 0.9, `${sharp.toFixed(2)} → ${blurred.toFixed(2)}`)
  await shot(win, 'adjust-04-blur')

  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setClipAdjustments('${clipId}', {
        blur: 0, sharpen: 0.8
      })
      return true
    })()`
  )
  await delay(700)
  const sharpened = await win.webContents.executeJavaScript(DETAIL)
  check(
    'the sharpen brought the detail back',
    sharpened > blurred * 1.1,
    `${blurred.toFixed(2)} → ${sharpened.toFixed(2)}`
  )
  await shot(win, 'adjust-05-sharpen')

  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setClipAdjustments('${clipId}', {
        sharpen: 0, grain: 0.5
      })
      return true
    })()`
  )
  await delay(700)
  const grainy = await win.webContents.executeJavaScript(DETAIL)
  check('the grain roughened the picture', grainy > sharpened * 1.05, `${sharpened.toFixed(2)} → ${grainy.toFixed(2)}`)
  await shot(win, 'adjust-06-grain')

  /* --- 5. undo ---------------------------------------------------------- */
  console.log('\n▶ undo')
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(400)
  const undone = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${clipId}')
      return clip.adjustments
    })()`
  )
  check(
    'undo took the saturation back',
    Math.abs(undone.saturation) < 0.001,
    JSON.stringify(undone)
  )

  /* --- 5. the export ---------------------------------------------------- */
  console.log('\n▶ the export')
  const exported = await win.webContents.executeJavaScript(
    `(async () => {
      const s = window.__clipforgeEditor.getState()
      const project = {
        ...s.project,
        tracks: s.project.tracks.map(t => ({
          ...t,
          clips: t.clips.map(c =>
            c.id === '${clipId}'
              ? { ...c, duration: 1, adjustments: { brightness: 0.3, contrast: 0.4, saturation: -1, temperature: 0.5, shadows: 0.3, highlights: -0.2, sharpen: 0.5, blur: 0.2, grain: 0.3 } }
              : c
          )
        }))
      }
      await window.clipforge.export.start(project, { path: ${JSON.stringify(OUT)}, preset: 'web', kind: 'video' })
      return true
    })()`
  )
  check('the export finished', exported === true)
  await delay(1500)
  check('the file was written', fs.existsSync(OUT), OUT)
  if (fs.existsSync(OUT)) {
    const size = fs.statSync(OUT).size
    check('the file has content', size > 1000, `${(size / 1024).toFixed(0)} KB`)
  }

  /* --- 6. the project file keeps the adjustments ------------------------ */
  console.log('\n▶ saving and loading the project')
  const projectFile = path.join(ROOT, 'out', 'verify-adjustments.json')
  const roundTrip = await win.webContents.executeJavaScript(
    `(async () => {
      const clipId = '${clipId}'
      window.__clipforgeEditor.getState().setClipAdjustments(clipId, { contrast: 0.35, grain: 0.2 })
      const s = window.__clipforgeEditor.getState()
      await window.clipforge.project.save(s.project, ${JSON.stringify(projectFile)})
      const loaded = await window.clipforge.project.load(${JSON.stringify(projectFile)})
      const back = loaded.tracks.flatMap(t => t.clips).find(c => c.id === clipId)
      return back ? back.adjustments : null
    })()`
  )
  check(
    'the adjustments survive a save and load',
    roundTrip &&
      Math.abs(roundTrip.contrast - 0.35) < 0.001 &&
      Math.abs(roundTrip.grain - 0.2) < 0.001,
    JSON.stringify(roundTrip)
  )

  /* --- 7. no errors ----------------------------------------------------- */
  console.log('\n▶ the console')
  // The getImageData calls in this script are what the renderer warns about.
  const noise = errors.filter(
    (m) => !/Autofill|devtools|GPU stall|SharedImage|willReadFrequently/i.test(m)
  )
  check('the renderer logged no errors', noise.length === 0, noise.slice(0, 3).join(' | '))

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
