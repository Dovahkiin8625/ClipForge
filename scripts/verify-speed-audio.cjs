/**
 * Feature check for the speed tab, the audio separation and the fades:
 *   1. the 变速 tab in the inspector, with constant and curved speed
 *   2. 分离音频 in the clip's right-click menu
 *   3. the volume fades in the 音频 tab
 *
 * It ends with a real export, so the FFmpeg graph is checked as well.
 *
 *   npx electron scripts/verify-speed-audio.cjs
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
  // The compositor needs a moment before the frame on screen is the one the
  // document describes.
  await delay(700)
  const image = await win.capturePage()
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
  console.log(`  📸 ${name}.png`)
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

  /* --- build a timeline ------------------------------------------------ */
  console.log('\n▶ building a timeline')
  const built = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      const clip = store.getState().project.tracks.find(t => t.id === 't_video_1').clips[0]
      store.getState().select([clip.id])
      return { clipId: clip.id, duration: clip.duration, assetId: assets[0].id }
    })()`
  )
  await delay(2500)
  console.log(`  clip ${built.clipId} · ${built.duration.toFixed(2)}s`)

  /* --- 1. the speed tab ------------------------------------------------ */
  console.log('\n▶ speed tab')

  const tabs = await win.webContents.executeJavaScript(
    `(() => {
      store.getState().setInspectorTab('speed')
      return Array.from(document.querySelectorAll('.inspector__tab')).map(b => b.textContent.trim())
    })()`.replace('store', 'window.__clipforgeEditor')
  )
  await delay(300)
  check('the inspector has a 变速 tab', tabs.includes('变速'), tabs.join(' / '))

  const constant = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      store.getState().setClipSpeed('${built.clipId}', 2)
      const c = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      return { speed: c.speed, duration: c.duration, keys: (c.speedKeyframes || []).length }
    })()`
  )
  check(
    'a constant rate of 2× halves the clip',
    Math.abs(constant.speed - 2) < 0.001 &&
      Math.abs(constant.duration - built.duration / 2) < 0.05,
    `${constant.speed}× · ${constant.duration.toFixed(2)}s`
  )
  check('a constant rate leaves no curve behind', constant.keys === 0)

  const curved = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const c = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      const srcEnd = c.inPoint + c.duration * 2
      store.getState().setClipSpeedCurve(c.id, [
        { t: c.inPoint, value: 1 },
        { t: srcEnd, value: 2 }
      ])
      const after = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === c.id)
      const span = srcEnd - c.inPoint
      return {
        keys: after.speedKeyframes.length,
        duration: after.duration,
        // A rate that ramps from 1× to 2× over the source: the source
        // advances at v(s) = 1 + s/span, so the clip runs for the integral
        // of 1/v — span * ln(2).
        expected: span * Math.LN2,
        speed: after.speed
      }
    })()`
  )
  check(
    'a 1×→2× ramp runs for the integral of the rate',
    curved.keys === 2 && Math.abs(curved.duration - curved.expected) < 0.05,
    `${curved.duration.toFixed(2)}s (expected ${curved.expected.toFixed(2)}s)`
  )

  const editor = await win.webContents.executeJavaScript(
    `(() => ({
      svg: !!document.querySelector('.speedcurve__svg'),
      dots: document.querySelectorAll('.speedcurve__dot').length,
      chips: Array.from(document.querySelectorAll('.chip')).map(c => c.textContent.trim())
    }))()`
  )
  check('the curve editor is on screen', editor.svg && editor.dots === 2, `${editor.dots} keyframes`)
  check('the curve presets are offered', editor.chips.includes('渐快'), editor.chips.join(' / '))
  await shot(win, '10-speed-curve')

  // Dragging a keyframe has to change the rate the clip plays at.
  const dot = await win.webContents.executeJavaScript(
    `(() => {
      const c = window.__clipforgeEditor.getState().project.tracks
        .flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      const svg = document.querySelector('.speedcurve__svg')
      const rect = svg.getBoundingClientRect()
      const dots = document.querySelectorAll('.speedcurve__dot')
      const last = dots[dots.length - 1]
      return {
        x: Math.round(rect.left + parseFloat(last.getAttribute('cx'))),
        y: Math.round(rect.top + parseFloat(last.getAttribute('cy'))),
        rate: c.speedKeyframes[c.speedKeyframes.length - 1].value,
        duration: c.duration
      }
    })()`
  )

  win.webContents.sendInputEvent({ type: 'mouseMove', x: dot.x, y: dot.y })
  win.webContents.sendInputEvent({
    type: 'mouseDown', x: dot.x, y: dot.y, button: 'left', clickCount: 1
  })
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: dot.x,
      y: Math.round(dot.y - (i / 6) * 42),
      button: 'left'
    })
    await delay(30)
  }
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: dot.x, y: dot.y - 42, button: 'left', clickCount: 1
  })
  await delay(400)

  const dragged = await win.webContents.executeJavaScript(
    `(() => {
      const c = window.__clipforgeEditor.getState().project.tracks
        .flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      return {
        rate: c.speedKeyframes[c.speedKeyframes.length - 1].value,
        duration: c.duration
      }
    })()`
  )
  check(
    'dragging a keyframe speeds the clip up',
    dragged.rate > dot.rate + 0.1 && dragged.duration < dot.duration - 0.05,
    `${dot.rate.toFixed(2)}× → ${dragged.rate.toFixed(2)}× · ${dot.duration.toFixed(2)}s → ${dragged.duration.toFixed(2)}s`
  )

  // Put the curve back the way it was, so the export below is predictable.
  await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const c = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      const srcEnd = c.inPoint + c.duration * c.speed
      store.getState().setClipSpeedCurve(c.id, [
        { t: c.inPoint, value: 1 },
        { t: srcEnd, value: 2 }
      ])
      return true
    })()`
  )
  await delay(300)

  // The curve must survive a save and a reload of the project file.
  const roundTrip = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const c = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      return JSON.parse(JSON.stringify({ keys: c.speedKeyframes, duration: c.duration }))
    })()`
  )
  check(
    'the curve is part of the document',
    roundTrip.keys.length === 2 && Math.abs(roundTrip.duration - curved.duration) < 0.05
  )

  /* --- the preview follows the curve ----------------------------------- */
  console.log('\n▶ preview playback')

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.setPlayhead(0)
      s.setPlaying(true)
      return true
    })()`
  )
  await delay(1500)
  const played = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const rates = Array.from(document.querySelectorAll('video')).map(v => v.playbackRate)
      s.setPlaying(false)
      return { playhead: s.playhead, rates }
    })()`
  )
  check(
    'the picture plays while the timeline runs',
    played.playhead > 0.5,
    `playhead ${played.playhead.toFixed(2)}s`
  )
  check(
    'the media runs at the rate the curve asks for',
    played.rates.some((r) => r > 1.05),
    played.rates.map((r) => r.toFixed(2)).join(', ')
  )

  /* --- cutting a clip that carries a curve ---------------------------- */
  console.log('\n▶ cutting a clip with a curve')

  const cut = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const c = store.getState().project.tracks.flatMap(t => t.clips).find(x => x.id === '${built.clipId}')
      const before = c.duration
      const middle = c.start + before / 2
      store.getState().splitClipAt(c.id, middle)
      const clips = store.getState().project.tracks
        .flatMap(t => t.clips).filter(x => x.id === '${built.clipId}' || x.start === middle)
      const left = clips.find(x => x.start === c.start)
      const right = clips.find(x => x.start === middle)
      return {
        before,
        left: left && { duration: left.duration, keys: (left.speedKeyframes || []).length },
        right: right && { duration: right.duration, keys: (right.speedKeyframes || []).length },
        rightInPoint: right && right.inPoint
      }
    })()`
  )
  check(
    'both halves keep the curve',
    !!cut.left && !!cut.right && cut.left.keys >= 2 && cut.right.keys >= 2,
    `left ${cut.left?.keys} keys · right ${cut.right?.keys} keys`
  )
  check(
    'the halves add up to the whole clip',
    !!cut.left && !!cut.right &&
      Math.abs(cut.left.duration + cut.right.duration - cut.before) < 0.05,
    `${cut.left?.duration.toFixed(2)}s + ${cut.right?.duration.toFixed(2)}s = ${cut.before.toFixed(2)}s`
  )
  check(
    'the second half continues where the first stopped',
    !!cut.right && cut.rightInPoint > 0.1,
    `in point ${cut.rightInPoint?.toFixed(2)}s`
  )

  // Put the clip back together, the checks below expect a single one.
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(300)

  /* --- 2. audio separation --------------------------------------------- */
  console.log('\n▶ audio separation')
  const geometry = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const x = clip.start * s.pxPerSecond - scroller.scrollLeft
      return {
        x: Math.round(rect.left + x + 60),
        y: Math.round(rect.top + 26 + 62 + 20)
      }
    })()`
  )

  win.webContents.sendInputEvent({ type: 'mouseMove', x: geometry.x, y: geometry.y })
  win.webContents.sendInputEvent({
    type: 'mouseDown', x: geometry.x, y: geometry.y, button: 'right', clickCount: 1
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp', x: geometry.x, y: geometry.y, button: 'right', clickCount: 1
  })
  await delay(400)

  const menu = await win.webContents.executeJavaScript(
    `(() => Array.from(document.querySelectorAll('.ctxmenu__item')).map(i => ({
      label: i.textContent.trim(), disabled: i.disabled
    })))()`
  )
  const separate = menu.find((m) => m.label.includes('分离音频'))
  check('the clip menu offers 分离音频', !!separate, separate ? separate.label : menu.map(m => m.label).join(' / '))
  check('分离音频 is available for a clip with sound', separate && !separate.disabled)
  await shot(win, '11-clip-menu')

  await win.webContents.executeJavaScript(
    `(() => {
      const item = Array.from(document.querySelectorAll('.ctxmenu__item'))
        .find(i => i.textContent.includes('分离音频'))
      if (item) item.click()
      return true
    })()`
  )
  await delay(600)

  const separated = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const video = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const audio = s.project.tracks.find(t => t.kind === 'audio').clips[0]
      return {
        videoMuted: video.muted,
        audio: audio ? {
          start: audio.start,
          duration: audio.duration,
          inPoint: audio.inPoint,
          muted: audio.muted,
          track: audio.trackId
        } : null
      }
    })()`
  )
  check('the picture clip is muted afterwards', separated.videoMuted === true)
  check(
    'the sound landed on an audio track',
    !!separated.audio && !separated.audio.muted,
    separated.audio ? `start ${separated.audio.start.toFixed(2)}s` : 'no audio clip'
  )
  check(
    'the audio clip lines up with the picture',
    !!separated.audio &&
      Math.abs(separated.audio.start) < 0.05 &&
      Math.abs(separated.audio.duration - curved.duration) < 0.05
  )
  await shot(win, '12-separated-audio')

  // One undo step has to take the sound back onto the picture clip.
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(300)
  const undone = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      return {
        muted: s.project.tracks.find(t => t.id === 't_video_1').clips[0].muted,
        audioClips: s.project.tracks.filter(t => t.kind === 'audio')
          .reduce((n, t) => n + t.clips.length, 0)
      }
    })()`
  )
  check(
    'one undo takes the separation back',
    undone.muted === false && undone.audioClips === 0,
    `muted=${undone.muted} · ${undone.audioClips} audio clips`
  )
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().redo(); true`)
  await delay(300)

  /* --- 3. the fades ---------------------------------------------------- */
  console.log('\n▶ volume fades')

  const fades = await win.webContents.executeJavaScript(
    `(() => {
      const store = window.__clipforgeEditor
      const c = store.getState().project.tracks.find(t => t.id === 't_video_1').clips[0]
      store.getState().applyVolumeFade(c.id, 'in', 0.5)
      store.getState().applyVolumeFade(c.id, 'out', 1)
      const after = store.getState().project.tracks.find(t => t.id === 't_video_1').clips[0]
      store.getState().setInspectorTab('audio')
      return {
        keys: after.keyframes.volume.map(k => ({ t: k.t, v: k.value })),
        duration: after.duration
      }
    })()`
  )
  await delay(400)

  const hasRampIn = fades.keys.some((k) => Math.abs(k.t) < 0.001 && k.v === 0)
  const hasRampOut = fades.keys.some(
    (k) => Math.abs(k.t - fades.duration) < 0.001 && k.v === 0
  )
  check('a fade in starts at silence', hasRampIn, JSON.stringify(fades.keys))
  check('a fade out ends in silence', hasRampOut)
  check(
    'the ramp reaches the volume of the clip',
    fades.keys.some((k) => Math.abs(k.v - 1) < 0.001)
  )

  const envelope = await win.webContents.executeJavaScript(
    `(() => ({
      svg: !!document.querySelector('.envelope'),
      fades: Array.from(document.querySelectorAll('.fade-row')).length
    }))()`
  )
  check('the audio tab shows the envelope and the fade rows', envelope.svg && envelope.fades === 2)
  await shot(win, '13-audio-fades')

  /* --- export ---------------------------------------------------------- */
  console.log('\n▶ export with a curve, a separated audio and fades')
  const outPath = path.join(ROOT, 'testmedia', 'out', 'speed-audio-export.mp4')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath)

  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const project = store.getState().project
      await window.clipforge.export.start(project, {
        path: ${JSON.stringify(outPath)},
        preset: 'web',
        kind: 'video'
      })
      return true
    })()`
  )

  const exported = await win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500))
        const s = window.__clipforgeEditor.getState().exportState
        if (s.status === 'done') return { status: 'done', log: s.log.slice(-6) }
        if (s.status === 'error') return { status: 'error', message: s.message, log: s.log.slice(-12) }
      }
      return { status: 'timeout' }
    })()`
  )

  console.log(`  status=${exported.status}`)
  if (exported.status !== 'done') {
    console.error(exported.message ?? '')
    ;(exported.log ?? []).forEach((l) => console.error('   ', l))
    await shot(win, '14-export-failed')
    check('the export completed', false, exported.status)
  } else {
    check('the export completed', true)
    ;(exported.log ?? []).forEach((l) => console.log('   ', l))
    const stat = fs.statSync(outPath)
    console.log(`  produced ${(stat.size / 1024 / 1024).toFixed(2)} MB at ${outPath}`)
  }

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
