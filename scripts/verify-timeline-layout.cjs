/**
 * Feature check for the timeline layout:
 *   1. two clips never share a stretch of a lane
 *   2. a clip that is dropped on a busy place moves to a free one
 *   3. the zoom reaches both ends without a fixed limit
 *
 *   npx electron scripts/verify-timeline-layout.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'clip-b.mp4')
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function shot(win, name) {
  await delay(700)
  const image = await win.capturePage()
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
  console.log(`  📸 ${name}.png`)
}

/** Every pair of clips on every lane, checked for overlap. */
function overlapsIn(tracks) {
  const bad = []
  for (const track of tracks) {
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    for (let i = 1; i < clips.length; i++) {
      const prev = clips[i - 1]
      const cur = clips[i]
      if (cur.start < prev.start + prev.duration - 1e-6) {
        bad.push(`${track.kind}: ${prev.id} [${prev.start},${prev.start + prev.duration}) and ${cur.id} [${cur.start},${cur.start + cur.duration})`)
      }
    }
  }
  return bad
}

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

  /* --- a timeline with two clips on one lane --------------------------- */
  console.log('\n▶ building a timeline')
  const built = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      s.insertClip(assets[1].id, 't_video_1', 10)
      const track = store.getState().project.tracks.find(t => t.id === 't_video_1')
      return track.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration }))
    })()`
  )
  await delay(2500)
  console.log('  ', JSON.stringify(built))

  const layout = () =>
    win.webContents.executeJavaScript(
      `(() => {
        const s = window.__clipforgeEditor.getState()
        return {
          tracks: s.project.tracks.map(t => ({
            kind: t.kind,
            name: t.name,
            clips: t.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration }))
          })),
          pxPerSecond: s.pxPerSecond
        }
      })()`
    )

  /* --- 1. dropping a clip on a busy place ------------------------------ */
  console.log('\n▶ dropping a clip on a busy place')
  const inserted = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = store.getState().project.assets
      const id = Object.keys(assets)[0]
      // Right on top of the second clip.
      store.getState().insertClip(id, 't_video_1', 12)
      const track = store.getState().project.tracks.find(t => t.id === 't_video_1')
      return track.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration }))
    })()`
  )
  console.log('  ', JSON.stringify(inserted))
  check(
    'the new clip found a free place',
    overlapsIn([
      {
        kind: 'video',
        clips: inserted
      }
    ]).length === 0,
    overlapsIn([{ kind: 'video', clips: inserted }]).join('; ')
  )
  check('the other clips did not move', inserted[0].start === 0 && inserted[1].start === 10)

  /* --- 2. dragging a clip onto another one ----------------------------- */
  console.log('\n▶ dragging a clip onto another one')
  const geometry = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const track = s.project.tracks.findIndex(t => t.id === 't_video_1')
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const x = clip.start * s.pxPerSecond - scroller.scrollLeft
      return {
        rect: { left: rect.left, top: rect.top },
        clipId: clip.id,
        pxPerSecond: s.pxPerSecond,
        screenX: rect.left + x + 60,
        screenY: rect.top + 26 + track * 62 + 30,
        // Where the clip would land if it were dropped 12 seconds later.
        dropX: rect.left + (clip.start + 12) * s.pxPerSecond - scroller.scrollLeft + 60
      }
    })()`
  )

  const drag = async (fromX, fromY, toX, toY) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY })
    win.webContents.sendInputEvent({
      type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1
    })
    for (let i = 1; i <= 8; i++) {
      const t = i / 8
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(fromX + (toX - fromX) * t),
        y: Math.round(fromY + (toY - fromY) * t),
        button: 'left'
      })
      await delay(25)
    }
    win.webContents.sendInputEvent({
      type: 'mouseUp', x: toX, y: toY, button: 'left', clickCount: 1
    })
    await delay(400)
  }

  await drag(geometry.screenX, geometry.screenY, geometry.dropX, geometry.screenY)

  const afterDrag = await layout()
  console.log('  ', JSON.stringify(afterDrag.tracks[1].clips))
  const bad = overlapsIn(afterDrag.tracks)
  check('the dragged clip landed on a free place', bad.length === 0, bad.join('; '))
  const moved = afterDrag.tracks.flatMap((t) => t.clips).find((c) => c.id === geometry.clipId)
  check('the clip really moved', Math.abs(moved.start - built[0].start) > 0.5, `start=${moved.start}`)
  await shot(win, '20-no-overlap')

  /* --- 3. the zoom reaches both ends ----------------------------------- */
  console.log('\n▶ the zoom')
  const zoom = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const slider = document.querySelector('.timeline__zoom-slider')
      store.getState().setZoom(1e9)
      const top = store.getState().pxPerSecond
      store.getState().setZoom(0)
      const bottom = store.getState().pxPerSecond
      store.getState().setZoom(60)
      return {
        top,
        bottom,
        back: store.getState().pxPerSecond,
        sliderMin: slider.min,
        sliderMax: slider.max
      }
    })()`
  )
  console.log('  ', JSON.stringify(zoom))
  check('the zoom goes far in', zoom.top > 10000, `${zoom.top.toFixed(0)} px/s`)
  check('the zoom goes far out', zoom.bottom <= 0.1, `${zoom.bottom} px/s`)
  check('the zoom slider spans the whole range', zoom.sliderMin === '0' && zoom.sliderMax === '1')

  // The picture has to survive both ends.
  await win.webContents.executeJavaScript(
    `(() => { window.__clipforgeEditor.getState().setZoom(1e9); return true })()`
  )
  await delay(500)
  await shot(win, '21-zoom-max')
  await win.webContents.executeJavaScript(
    `(() => { window.__clipforgeEditor.getState().setZoom(0.1); return true })()`
  )
  await delay(500)
  await shot(win, '22-zoom-min')
  await win.webContents.executeJavaScript(
    `(() => { window.__clipforgeEditor.getState().setZoom(60); return true })()`
  )

  /* --- 4. the lanes stay clear while editing --------------------------- */
  console.log('\n▶ the lanes stay clear')
  const busy = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const s = store.getState()
      const video = s.project.tracks.find(t => t.id === 't_video_1')
      const clip = video.clips[0]
      // A clip that grows into its neighbour has to push it along.
      store.getState().setClipSpeed(clip.id, 0.25)
      const after = store.getState().project.tracks.map(t => ({
        kind: t.kind,
        clips: t.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration }))
      }))
      return after
    })()`
  )
  console.log('  ', JSON.stringify(busy))
  check('a clip that grows pushes its neighbour', overlapsIn(busy).length === 0, overlapsIn(busy).join('; '))

  if (errors.length) {
    console.log('\n⚠ renderer errors:')
    errors.slice(0, 12).forEach((e) => console.log('   ', e))
  } else {
    console.log('\n✅ no renderer errors')
  }

  console.log(failures === 0 ? '\n✅ all checks passed' : `\n❌ ${failures} check(s) failed`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
