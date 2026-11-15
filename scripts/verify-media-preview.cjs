/**
 * Checks the media library: a double click opens the preview window and the
 * "+" button puts the asset on a track — an audio file on an audio track.
 *
 *   npx electron scripts/verify-media-preview.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []

function check(label, ok) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`)
  if (!ok) failures.push(label)
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
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`  [console] ${message}`)
  })

  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
    })()`
  )
  await delay(1500)

  const cards = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const assets = Object.values(s.project.assets)
      return assets.map((a, i) => ({ index: i, id: a.id, kind: a.kind, name: a.name }))
    })()`
  )
  console.log('  assets:', JSON.stringify(cards))

  /* --- the double click opens the preview window ------------------------- */

  await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelectorAll('.asset-card')[0]
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`
  )
  await delay(800)
  const preview = await win.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('.dialog--preview')
      if (!dialog) return null
      return {
        title: dialog.querySelector('.dialog__title')?.textContent ?? '',
        hasMedia: !!dialog.querySelector('video, audio, img'),
        mediaTag: dialog.querySelector('video, audio, img')?.tagName ?? ''
      }
    })()`
  )
  check('a double click opens the preview window', !!preview)
  check(
    'the preview window plays the asset',
    !!preview && preview.hasMedia,
    preview && preview.mediaTag
  )
  console.log('     ', JSON.stringify(preview))

  // The window closes again.
  await win.webContents.executeJavaScript(
    `document.querySelector('.dialog--preview .btn--icon').click()`
  )
  await delay(400)
  const closed = await win.webContents.executeJavaScript(
    `!document.querySelector('.dialog--preview')`
  )
  check('the preview window closes', closed)

  // The audio file gets a player of its own.
  const audioIndex = cards.findIndex((c) => c.kind === 'audio')
  await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelectorAll('.asset-card')[${audioIndex}]
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })()`
  )
  await delay(800)
  const audioPreview = await win.webContents.executeJavaScript(
    `(() => {
      const dialog = document.querySelector('.dialog--preview')
      if (!dialog) return null
      return {
        hasPlayer: !!dialog.querySelector('audio'),
        hasWave: !!dialog.querySelector('.preview-dialog__wave')
      }
    })()`
  )
  check(
    'the audio preview has a player and a waveform',
    !!audioPreview && audioPreview.hasPlayer && audioPreview.hasWave
  )
  console.log('     ', JSON.stringify(audioPreview))
  await win.webContents.executeJavaScript(
    `document.querySelector('.dialog--preview .btn--icon').click()`
  )
  await delay(300)

  /* --- the "+" button puts the asset on a track -------------------------- */

  const before = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      return s.project.tracks.map(t => ({ kind: t.kind, clips: t.clips.length }))
    })()`
  )
  console.log('  tracks before:', JSON.stringify(before))

  // The audio card is the one whose asset is of the audio kind.
  await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelectorAll('.asset-card')[${audioIndex}]
      el.querySelector('.asset-card__add').click()
    })()`
  )
  await delay(800)

  const after = await win.webContents.executeJavaScript(
    `(() => {
      const s = window.__clipforgeEditor.getState()
      const assetId = ${JSON.stringify(cards[audioIndex].id)}
      const clip = s.project.tracks.flatMap(t => t.clips).find(c => c.assetId === assetId)
      const track = s.project.tracks.find(t => t.id === clip?.trackId)
      return { trackKind: track?.kind ?? null, clipCount: s.project.tracks.flatMap(t => t.clips).length }
    })()`
  )
  console.log('  after adding the audio:', JSON.stringify(after))
  check('the "+" button adds the asset', after.clipCount > 0)
  check('the audio file lands on an audio track', after.trackKind === 'audio')

  console.log('')
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} check(s) failed`)
    app.exit(1)
  }
  console.log('✅ the media library previews and adds as it should')
  app.exit(0)
}

run().catch((e) => {
  console.error(e)
  app.exit(1)
})
