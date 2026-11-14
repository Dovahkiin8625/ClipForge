/**
 * Renders the ClipForge app mark to PNG at several sizes.
 *
 * The mark is drawn as SVG and rasterised through Electron's own renderer,
 * so the icon stays pixel-identical to the one in the title bar.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')

const MARK = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2230"/>
      <stop offset="1" stop-color="#0b0e13"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#bg)"/>
  <rect x="26" y="26" width="460" height="460" rx="88" fill="none" stroke="#2d3745" stroke-width="6"/>

  <!-- film strip body -->
  <rect x="92" y="126" width="328" height="260" rx="14" fill="#0b0e13" stroke="#3a4655" stroke-width="6"/>

  <!-- three frames -->
  <rect x="112" y="146" width="86" height="220" rx="6" fill="#f2a03d"/>
  <rect x="213" y="146" width="86" height="220" rx="6" fill="#f2a03d" opacity="0.55"/>
  <rect x="314" y="146" width="86" height="220" rx="6" fill="#3fd9c0" opacity="0.8"/>

  <!-- sprocket holes -->
  <g fill="#0b0e13">
    <rect x="112" y="78" width="46" height="26" rx="8"/>
    <rect x="182" y="78" width="46" height="26" rx="8"/>
    <rect x="252" y="78" width="46" height="26" rx="8"/>
    <rect x="322" y="78" width="46" height="26" rx="8"/>
    <rect x="392" y="78" width="46" height="26" rx="8"/>
    <rect x="112" y="408" width="46" height="26" rx="8"/>
    <rect x="182" y="408" width="46" height="26" rx="8"/>
    <rect x="252" y="408" width="46" height="26" rx="8"/>
    <rect x="322" y="408" width="46" height="26" rx="8"/>
    <rect x="392" y="408" width="46" height="26" rx="8"/>
  </g>
</svg>`

async function main() {
  fs.mkdirSync(BUILD, { recursive: true })
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    frame: false,
    transparent: true,
    show: false,
    webPreferences: { offscreen: true }
  })

  const html =
    `<!doctype html><html><head><style>` +
    `html,body{margin:0;padding:0;width:512px;height:512px;overflow:hidden;background:transparent}` +
    `svg{display:block}` +
    `</style></head><body>${MARK}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const buffer = image.toPNG()
  fs.writeFileSync(path.join(BUILD, 'icon.png'), buffer)
  console.log('wrote build/icon.png', buffer.length, 'bytes')

  win.destroy()
  app.exit(0)
}

app.whenReady().then(main).catch((err) => {
  console.error(err)
  app.exit(1)
})
