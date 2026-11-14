/**
 * Feature check for the three timeline additions:
 *   1. dragging a clip onto another video track
 *   2. typing a transform value and seeing the preview follow along
 *   3. the right-click menus on clips, tracks and the empty timeline
 *
 *   npx electron scripts/verify-features.cjs
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'clip-b.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]

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

  /* --- build a timeline ------------------------------------------------ */
  console.log('\n▶ building a timeline')
  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      s.insertClip(assets[1].id, 't_video_1', 10)
      s.insertClip(assets[2].id, 't_audio_1', 0)
      store.getState().setPlayhead(1)
      return true
    })()`
  )
  await delay(2500)

  const geometry = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const clip = s.project.tracks.find(t => t.id === 't_video_1').clips[0]
      const x = clip.start * s.pxPerSecond - scroller.scrollLeft
      return {
        rect: { left: rect.left, top: rect.top },
        clipId: clip.id,
        pxPerSecond: s.pxPerSecond,
        screenX: rect.left + x + 60,
        screenY: rect.top + 26 + 62 + 20
      }
    })()`
  )

  /* --- 1. drag a clip onto the other video track ----------------------- */
  console.log('\n▶ cross-track drag')

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
    await delay(300)
  }

  // The upper lane (index 0) is the "视频 2" track.
  const upperLaneY = geometry.rect.top + 26 + 20
  await drag(geometry.screenX, geometry.screenY, geometry.screenX + 40, upperLaneY)

  const afterDrag = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const where = s.project.tracks.map(t => ({
        id: t.id,
        clips: t.clips.map(c => c.id)
      }))
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return { where, trackId: clip ? clip.trackId : null }
    })()`
  )
  console.log('   ', JSON.stringify(afterDrag.where))
  check(
    'the clip now lives on the other video track',
    afterDrag.where.find((t) => t.id === 't_video_2')?.clips.includes(geometry.clipId) === true,
    `trackId=${afterDrag.trackId}`
  )
  check(
    'the clip left the old track',
    afterDrag.where.find((t) => t.id === 't_video_1')?.clips.includes(geometry.clipId) === false
  )
  await shot(win, '06-cross-track-drag')

  // Undo has to put it back.
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(250)
  const afterUndo = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const inOld = s.project.tracks.find(t => t.id === 't_video_1').clips.some(c => c.id === '${geometry.clipId}')
      const inNew = s.project.tracks.find(t => t.id === 't_video_2').clips.some(c => c.id === '${geometry.clipId}')
      return { inOld, inNew }
    })()`
  )
  check('undo moves the clip back', afterUndo.inOld && !afterUndo.inNew)

  /* --- 2. typing a transform value ------------------------------------- */
  console.log('\n▶ transform number field')

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.select(['${geometry.clipId}'])
      s.setInspectorTab('transform')
      s.setPlayhead(s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}').start + 0.5)
      return true
    })()`
  )
  await delay(900)

  const fields = await win.webContents.executeJavaScript(
    `(() => {
      const inputs = [...document.querySelectorAll('.inspector__row .prop__num-input')]
      return inputs.map(i => ({ label: i.getAttribute('aria-label'), value: i.value }))
    })()`
  )
  console.log('   ', JSON.stringify(fields))
  check(
    'the four transform fields are present',
    ['水平', '垂直', '缩放', '旋转'].every((label) => fields.some((f) => f.label === label)),
    fields.map((f) => f.label).join(', ')
  )

  const before = await win.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas.preview__canvas')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4 * 131) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7
      return sum
    })()`
  )

  // Type "35" into the horizontal position field.
  const typed = await win.webContents.executeJavaScript(
    `(() => {
      const input = [...document.querySelectorAll('.inspector__row .prop__num-input')]
        .find(i => i.getAttribute('aria-label') === '水平')
      if (!input) return { error: 'no field' }
      input.focus()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '35')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return { ok: true }
    })()`
  )
  check('the field accepts typed input', typed.ok === true)
  await delay(700)

  const transform = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return { x: clip.transform.x, value: clip.transform.x * 100 }
    })()`
  )
  check(
    'the typed value reached the document',
    Math.abs(transform.value - 35) < 0.01,
    `x=${transform.x}`
  )

  const after = await win.webContents.executeJavaScript(
    `(() => {
      const c = document.querySelector('canvas.preview__canvas')
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let sum = 0
      for (let i = 0; i < d.length; i += 4 * 131) sum += d[i] + d[i + 1] * 3 + d[i + 2] * 7
      return sum
    })()`
  )
  check('the preview followed the edit', before !== after, `${before} → ${after}`)
  await shot(win, '07-transform-typed')

  // Undo must restore the original position.
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(250)
  const undone = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return clip.transform.x
    })()`
  )
  check('one undo restores the position', Math.abs(undone) < 0.001, `x=${undone}`)

  /* --- 3. right-click menus -------------------------------------------- */
  console.log('\n▶ right-click menus')

  const rightClick = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    win.webContents.sendInputEvent({
      type: 'mouseDown', x, y, button: 'right', clickCount: 1
    })
    win.webContents.sendInputEvent({
      type: 'mouseUp', x, y, button: 'right', clickCount: 1
    })
    await delay(350)
  }

  // On a clip.
  await rightClick(geometry.screenX, geometry.screenY)
  const clipMenu = await win.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('.ctxmenu')
      if (!menu) return null
      return [...menu.querySelectorAll('.ctxmenu__item')].map(b => b.textContent)
    })()`
  )
  const clipMenuState = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const menu = document.querySelector('.ctxmenu')
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return {
        playhead: s.playhead,
        clipStart: clip.start,
        clipDuration: clip.duration,
        items: [...menu.querySelectorAll('.ctxmenu__item')].map(b => ({
          text: b.textContent.slice(0, 8),
          disabled: b.disabled
        }))
      }
    })()`
  )
  console.log('    ', JSON.stringify(clipMenuState))
  check('the clip menu opens', clipMenu !== null, clipMenu ? clipMenu.length + ' items' : '')
  check(
    'the clip menu carries the expected commands',
    clipMenu &&
      clipMenu.some((t) => t.includes('分割')) &&
      clipMenu.some((t) => t.includes('复制片段')) &&
      clipMenu.some((t) => t.includes('移到上一轨'))
  )
  await shot(win, '08-clip-menu')

  // "复制片段" duplicates the clip.
  const beforeCount = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0)`
  )
  await win.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('.ctxmenu__item')]
      const target = items.find(b => b.textContent.includes('复制片段'))
      target.click()
      return true
    })()`
  )
  await delay(350)
  const afterCount = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0)`
  )
  check('the menu command runs', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`)
  check(
    'the menu closed after the command',
    (await win.webContents.executeJavaScript(`!document.querySelector('.ctxmenu')`)) === true
  )

  // On a track header.
  const headBox = await win.webContents.executeJavaScript(
    `(() => {
      const head = document.querySelector('.track-head')
      const r = head.getBoundingClientRect()
      return { x: Math.round(r.left + 40), y: Math.round(r.top + 12) }
    })()`
  )
  await rightClick(headBox.x, headBox.y)
  const trackMenu = await win.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('.ctxmenu')
      if (!menu) return null
      return [...menu.querySelectorAll('.ctxmenu__item')].map(b => b.textContent)
    })()`
  )
  check('the track menu opens', trackMenu !== null, trackMenu ? trackMenu.join(' | ') : '')
  check(
    'the track menu carries the expected commands',
    trackMenu &&
      trackMenu.some((t) => t.includes('重命名轨道')) &&
      trackMenu.some((t) => t.includes('锁定轨道')) &&
      trackMenu.some((t) => t.includes('删除轨道'))
  )
  await shot(win, '09-track-menu')

  // Renaming through the menu.
  await win.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('.ctxmenu__item')]
      items.find(b => b.textContent.includes('重命名轨道')).click()
      return true
    })()`
  )
  await delay(250)
  const renamed = await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('.track-head__rename')
      if (!input) return { error: 'no input' }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '主视频')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return { ok: true }
    })()`
  )
  check('the rename field appears', renamed.ok === true)
  await delay(300)
  const trackName = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks[0].name`
  )
  check('the track was renamed', trackName === '主视频', `name=${trackName}`)

  // On the empty part of the timeline — the top lane holds no clip here.
  const emptyPoint = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const r = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      // The first lane that has no clip at all.
      const emptyTrack = s.project.tracks.find(t => t.clips.length === 0)
      const lane = emptyTrack ? s.project.tracks.indexOf(emptyTrack) : 0
      return {
        x: Math.round(r.left + 120 - scroller.scrollLeft),
        y: Math.round(r.top + 26 + 62 * lane + 20)
      }
    })()`
  )
  await rightClick(emptyPoint.x, emptyPoint.y)
  const timelineMenu = await win.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('.ctxmenu')
      if (!menu) return null
      return [...menu.querySelectorAll('.ctxmenu__item')].map(b => b.textContent)
    })()`
  )
  check('the timeline menu opens', timelineMenu !== null, timelineMenu ? timelineMenu.join(' | ') : '')
  await shot(win, '10-timeline-menu')

  // Escape closes it.
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`
  )
  await delay(250)
  check(
    'Escape closes the menu',
    (await win.webContents.executeJavaScript(`!document.querySelector('.ctxmenu')`)) === true
  )

  /* --- 4. moving a clip through the menu ------------------------------- */
  console.log('\n▶ moving a clip through the menu')

  const beforeMove = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return { trackId: clip.trackId, trackIndex: s.project.tracks.findIndex(t => t.id === clip.trackId) }
    })()`
  )
  await rightClick(geometry.screenX, geometry.screenY)
  await win.webContents.executeJavaScript(
    `(() => {
      const items = [...document.querySelectorAll('.ctxmenu__item')]
      const target = items.find(b => b.textContent.includes('移到上一轨'))
      if (!target) return 'missing'
      target.click()
      return 'clicked'
    })()`
  )
  await delay(350)
  const afterMove = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return {
        trackId: clip.trackId,
        trackIndex: s.project.tracks.findIndex(t => t.id === clip.trackId),
        onTrack: s.project.tracks.find(t => t.id === clip.trackId).clips.some(c => c.id === clip.id)
      }
    })()`
  )
  check(
    'the menu moved the clip one track up',
    afterMove.trackIndex === beforeMove.trackIndex - 1 && afterMove.onTrack,
    `${beforeMove.trackIndex} → ${afterMove.trackIndex}`
  )

  /* --- 5. a locked track does not move ---------------------------------- */
  console.log('\n▶ locked track')

  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.toggleTrackFlag('${afterMove.trackId}', 'locked')
      return true
    })()`
  )
  await delay(200)

  const lockedClip = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const track = s.project.tracks.find(t => t.id === '${afterMove.trackId}')
      const clip = track.clips[0]
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const lane = s.project.tracks.indexOf(track)
      return {
        id: clip.id,
        start: clip.start,
        x: Math.round(rect.left + clip.start * s.pxPerSecond - scroller.scrollLeft + 60),
        y: Math.round(rect.top + 26 + 62 * lane + 20)
      }
    })()`
  )
  await drag(lockedClip.x, lockedClip.y, lockedClip.x + 120, lockedClip.y)
  const afterLockedDrag = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const track = s.project.tracks.find(t => t.id === '${afterMove.trackId}')
      return track.clips.find(c => c.id === '${lockedClip.id}').start
    })()`
  )
  check(
    'a locked track keeps its clip in place',
    Math.abs(afterLockedDrag - lockedClip.start) < 0.001,
    `start ${lockedClip.start} → ${afterLockedDrag}`
  )

  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().toggleTrackFlag('${afterMove.trackId}', 'locked')
      return true
    })()`
  )
  await delay(200)

  /* --- 6. reordering tracks --------------------------------------------- */
  console.log('\n▶ track order')

  const orderBefore = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.map(t => t.id).join(',')`
  )
  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.moveTrack('t_video_1', -1)
      return true
    })()`
  )
  await delay(250)
  const orderAfter = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.map(t => t.id).join(',')`
  )
  check(
    'a video track moved up',
    orderAfter === 't_video_1,t_video_2,t_audio_1',
    `${orderBefore} → ${orderAfter}`
  )
  await win.webContents.executeJavaScript(`window.__clipforgeEditor.getState().undo(); true`)
  await delay(200)

  /* --- 7. the audio clip menu ------------------------------------------- */
  console.log('\n▶ audio clip menu')

  const audioPoint = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const canvas = document.querySelector('canvas.timeline__canvas--dynamic')
      const rect = canvas.getBoundingClientRect()
      const scroller = document.querySelector('.timeline__scroller')
      const lane = s.project.tracks.findIndex(t => t.id === 't_audio_1')
      const clip = s.project.tracks[lane].clips[0]
      return {
        x: Math.round(rect.left + clip.start * s.pxPerSecond - scroller.scrollLeft + 40),
        y: Math.round(rect.top + 26 + 62 * lane + 20)
      }
    })()`
  )
  await rightClick(audioPoint.x, audioPoint.y)
  const audioMenu = await win.webContents.executeJavaScript(
    `(() => {
      const menu = document.querySelector('.ctxmenu')
      if (!menu) return null
      return [...menu.querySelectorAll('.ctxmenu__item')].map(b => b.textContent)
    })()`
  )
  check('the audio clip menu opens', audioMenu !== null)
  check(
    'the audio clip menu offers a volume reset instead of a transform reset',
    audioMenu && audioMenu.some((t) => t.includes('重置音量')) && !audioMenu.some((t) => t.includes('重置变换'))
  )
  await shot(win, '11-audio-menu')

  /* --- 5. dragging the clip in the picture ----------------------------- */
  console.log('\n▶ dragging in the preview')

  const dragPreview = async (fromX, fromY, toX, toY) => {
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
    await delay(300)
  }

  // The clip is made smaller so that the handles sit inside the picture.
  await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      s.select(['${geometry.clipId}'])
      s.setClipTransform('${geometry.clipId}', { scale: 0.5, rotation: 0 })
      s.setPlayhead(s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}').start + 0.5)
      return true
    })()`
  )
  await delay(900)

  const handles = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      const c = document.querySelector('canvas.preview__canvas')
      const r = c.getBoundingClientRect()
      const { width: W, height: H } = s.project.settings
      const o = window.__clipforgePreview.overlay()
      const toScreen = (x, y) => ({
        x: r.left + (x / W) * r.width,
        y: r.top + (y / H) * r.height
      })
      return {
        centre: toScreen(o.center.x, o.center.y),
        corner: toScreen(o.corners[1].x, o.corners[1].y),
        turn: toScreen(o.rotate.x, o.rotate.y)
      }
    })()`
  )

  // Drag the clip by its middle.
  await dragPreview(handles.centre.x, handles.centre.y, handles.centre.x + 60, handles.centre.y + 30)
  const moved = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.id === '${geometry.clipId}')
      return { x: clip.transform.x, y: clip.transform.y }
    })()`
  )
  check(
    'dragging the picture moves the clip',
    moved.x > 0.001 || moved.y > 0.001,
    `x=${moved.x.toFixed(3)} y=${moved.y.toFixed(3)}`
  )
  await shot(win, '12-preview-moved')

  // Drag the corner to make it bigger.
  const cornerBefore = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.flatMap(t => t.clips)
       .find(c => c.id === '${geometry.clipId}').transform.scale`
  )
  const corner = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const c = document.querySelector('canvas.preview__canvas')
      const r = c.getBoundingClientRect()
      const { width: W, height: H } = s.project.settings
      const o = window.__clipforgePreview.overlay()
      return {
        x: r.left + (o.corners[1].x / W) * r.width,
        y: r.top + (o.corners[1].y / H) * r.height
      }
    })()`
  )
  await dragPreview(corner.x, corner.y, corner.x + 70, corner.y + 45)
  const cornerAfter = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.flatMap(t => t.clips)
       .find(c => c.id === '${geometry.clipId}').transform.scale`
  )
  check(
    'dragging the corner makes the clip bigger',
    cornerAfter > cornerBefore * 1.1,
    `${cornerBefore.toFixed(2)} → ${cornerAfter.toFixed(2)}`
  )
  await shot(win, '13-preview-scaled')

  // Drag the handle that turns the clip.
  const turn = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const c = document.querySelector('canvas.preview__canvas')
      const r = c.getBoundingClientRect()
      const { width: W, height: H } = s.project.settings
      const o = window.__clipforgePreview.overlay()
      return {
        x: r.left + (o.rotate.x / W) * r.width,
        y: r.top + (o.rotate.y / H) * r.height
      }
    })()`
  )
  await dragPreview(turn.x, turn.y, turn.x + 80, turn.y + 20)
  const turned = await win.webContents.executeJavaScript(
    `window.__clipforgeEditor.getState().project.tracks.flatMap(t => t.clips)
       .find(c => c.id === '${geometry.clipId}').transform.rotation`
  )
  check('the handle turns the clip', Math.abs(turned) > 1, `${turned.toFixed(1)}°`)
  await shot(win, '14-preview-turned')

  /* --- 6. the size of the canvas --------------------------------------- */
  console.log('\n▶ the size of the canvas')

  const sizeChip = await win.webContents.executeJavaScript(
    `(() => {
      const button = [...document.querySelectorAll('.titlebar__right button')]
        .find(b => /^\\d+×\\d+$/.test(b.textContent.trim()))
      return button ? button.textContent.trim() : null
    })()`
  )
  check('the title bar shows the size of the canvas', sizeChip !== null, sizeChip ?? '')

  await win.webContents.executeJavaScript(
    `(() => {
      const button = [...document.querySelectorAll('.titlebar__right button')]
        .find(b => /^\\d+×\\d+$/.test(b.textContent.trim()))
      button.click()
      return true
    })()`
  )
  await delay(300)
  const menuOpen = await win.webContents.executeJavaScript(
    `document.querySelector('.canvas-menu') !== null`
  )
  check('the size panel opens', menuOpen === true)
  await shot(win, '15-canvas-menu')

  await win.webContents.executeJavaScript(
    `(() => {
      const chip = [...document.querySelectorAll('.canvas-menu .chip')]
        .find(c => c.textContent.trim() === '9:16')
      chip.click()
      return true
    })()`
  )
  await delay(400)
  const resized = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      return { width: s.project.settings.width, height: s.project.settings.height }
    })()`
  )
  check(
    'the canvas takes the chosen size',
    resized.width === 1080 && resized.height === 1920,
    `${resized.width}×${resized.height}`
  )
  await shot(win, '16-canvas-resized')

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
