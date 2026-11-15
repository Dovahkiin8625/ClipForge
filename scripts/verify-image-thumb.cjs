/**
 * Checks that a still picture gets a usable thumbnail sprite.
 *
 * FFmpeg cannot run a JPEG through the `fps`/`tile` filters — it writes an
 * empty sheet — so a picture has to be scaled on its own.
 *
 *   npx electron scripts/verify-image-thumb.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PICTURES = [
  path.join(ROOT, 'testmedia', 'still-b.jpg'),
  path.join(ROOT, 'testmedia', 'still-a.png')
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

  for (const picture of PICTURES) {
    const result = await win.webContents.executeJavaScript(
      `(async () => {
        const sheet = await window.clipforge.media.sprite(${JSON.stringify(picture)}, 0, 0.2, 1, 160, true)
        const img = new Image()
        const ok = await new Promise((resolve) => {
          img.onload = () => resolve(true)
          img.onerror = () => resolve(false)
          img.src = sheet.url
        })
        return { ok, width: img.naturalWidth, height: img.naturalHeight, sheet }
      })()`
    )
    check(
      `${path.basename(picture)} → sheet ${result.sheet.frameWidth}×${result.sheet.frameHeight} loaded=${result.ok}`,
      result.ok && result.width > 0
    )
  }

  await delay(300)

  // The library card of a picture must show the picture itself.
  const card = await win.webContents.executeJavaScript(
    `(async () => {
      const imported = await window.clipforge.media.importPaths(${JSON.stringify(PICTURES)})
      const store = window.__clipforgeEditor.getState()
      store.addAssets(imported)
      await new Promise((r) => setTimeout(r, 1500))
      const img = document.querySelector('.asset-card__thumb--image img')
      if (!img) return { found: false }
      const loaded = await new Promise((resolve) => {
        if (img.complete) return resolve(img.naturalWidth > 0)
        img.onload = () => resolve(img.naturalWidth > 0)
        img.onerror = () => resolve(false)
      })
      return { found: true, loaded, src: img.getAttribute('src') }
    })()`
  )
  check('library card shows the picture', card.found && card.loaded)
  console.log('  detail: ' + JSON.stringify(card))

  if (failures.length) {
    console.error(`\n❌ ${failures.length} check(s) failed`)
    app.exit(1)
  }
  console.log('\n✅ all checks passed')
  app.exit(0)
}

app.on('window-all-closed', () => {})
run().catch((err) => {
  console.error(err)
  app.exit(1)
})
