/**
 * Feature check for the vocal separation:
 *   1. the clip context menu offers 人声分离
 *   2. running it puts the voice on an audio track and mutes the picture
 *   3. the result is a real audio file on disk
 *
 *   npx electron scripts/verify-vocals.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [path.join(ROOT, 'testmedia', 'clip-a.mp4')]

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

  console.log('\n▶ building a timeline')
  const clipId = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      store.getState().insertClip(assets[0].id, 't_video_1', 0)
      const s = store.getState()
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      return clip.id
    })()`
  )
  await delay(1500)

  /* --- 1. the menu offers 人声分离 ------------------------------------- */
  console.log('\n▶ clip context menu')

  const geometry = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const x = clip.start * s.pxPerSecond - scroller.scrollLeft
      return {
        x: rect.left + x + 60,
        y: rect.top + 26 + 62 + 20,
        clipId: clip.id
      }
    })()`
  )

  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    button: 'right',
    clickCount: 1
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(geometry.x),
    y: Math.round(geometry.y),
    button: 'right',
    clickCount: 1
  })
  await delay(400)

  const menu = await win.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('.ctxmenu')
      if (!menu) return null
      return [...menu.querySelectorAll('.ctxmenu__item')].map(b => ({
        label: b.textContent,
        disabled: b.disabled
      }))
    })()`
  )
  console.log('   ', JSON.stringify(menu))
  check('the menu opened on the clip', Array.isArray(menu))
  const vocalItem = (menu || []).find((item) => item.label.startsWith('人声分离'))
  check('the menu offers 人声分离', !!vocalItem)
  check('人声分离 is enabled for a clip with sound', vocalItem && !vocalItem.disabled)
  await shot(win, 'vocal-01-menu')

  /* --- 2. run the separation ------------------------------------------- */
  console.log('\n▶ separating the voice')

  const started = Date.now()
  await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().separateClipVocals('${clipId}').then(() => true)`
  )
  await delay(400)

  // The separation runs in the main process; wait for it to settle.
  let state = null
  for (let i = 0; i < 120; i++) {
    state = await win.webContents.executeJavaScript(
      `(() => {
        const s = window.__clipforgeEditor.getState()
        return { status: s.vocalState.status, message: s.vocalState.message }
      })()`
    )
    if (state.status === 'done' || state.status === 'error') break
    await delay(500)
  }
  console.log('   ', JSON.stringify(state), `${Math.round((Date.now() - started) / 1000)}s`)
  check('the separation finished', state.status === 'done', state.message)

  const result = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const original = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${clipId}')
      const audioTracks = s.project.tracks.filter(t => t.kind === 'audio')
      const vocals = audioTracks.flatMap(t => t.clips)
      const asset = vocals.length ? s.project.assets[vocals[0].assetId] : null
      return {
        originalMuted: original ? original.muted : null,
        audioTrackCount: audioTracks.length,
        vocalClips: vocals.map(c => ({
          start: c.start,
          duration: c.duration,
          inPoint: c.inPoint,
          speed: c.speed
        })),
        asset: asset ? { kind: asset.kind, path: asset.path, duration: asset.duration } : null
      }
    })()`
  )
  console.log('   ', JSON.stringify(result))
  check('the picture clip is muted', result.originalMuted === true)
  check('a voice clip sits on an audio track', result.vocalClips.length === 1)
  check(
    'the voice clip starts where the picture does',
    result.vocalClips[0]?.start === 0
  )
  check(
    'the voice clip runs at the speed of the picture',
    result.vocalClips[0]?.speed === 1
  )
  check('the result is an audio asset', result.asset?.kind === 'audio')
  check('the result is a file on disk', !!result.asset && fs.existsSync(result.asset.path))
  await shot(win, 'vocal-02-separated')

  /* --- 3. undo ---------------------------------------------------------- */
  console.log('\n▶ undo')
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(400)
  const undone = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const original = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${clipId}')
      const vocals = s.project.tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips)
      return { muted: original?.muted, vocalCount: vocals.length }
    })()`
  )
  check('undo takes the voice clip away again', undone.vocalCount === 0)
  check('undo unmutes the picture clip', undone.muted === false)

  const realErrors = errors.filter((e) => !/Autofill|devtools/i.test(e))
  check('no errors in the console', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
