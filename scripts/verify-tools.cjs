/**
 * Checks the two tool workspaces:
 *   1. the conversion workspace converts a real file
 *   2. the download workspace reports a missing yt-dlp instead of crashing
 *
 *   npx electron scripts/verify-tools.cjs
 */
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

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

  // The file picker is answered with the test clip: the conversion takes a
  // file from disk, not something out of the project.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [MEDIA[0]] })

  /* --- the conversion workspace ---------------------------------------- */
  console.log('\n▶ the conversion workspace')
  await win.webContents.executeJavaScript(
    `(async () => {
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      window.__clipforgeEditor.getState().addAssets(assets)
    })()`
  )
  await delay(600)

  // Switch to the conversion workspace through the title bar.
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.segmented--mode .segmented__item'))
      const convert = buttons.find((b) => b.textContent.trim() === '转换')
      if (convert) convert.click()
      return Boolean(convert)
    })()
  `)
  await delay(500)

  const modeShown = await win.webContents.executeJavaScript(`
    Boolean(document.querySelector('.tool__col--params'))
  `)
  check('the conversion workspace opens', modeShown)
  await shot(win, '10-convert-workspace')

  // The source is a file on disk: the picker is answered with the test clip.
  await win.webContents.executeJavaScript(`
    (() => {
      const button = Array.from(
        document.querySelectorAll('.tool__col--source button')
      ).find((b) => b.textContent.trim() === '选择文件…')
      if (!button) return false
      button.click()
      return true
    })()
  `)
  await delay(1200)

  const sourceShown = await win.webContents.executeJavaScript(`
    Boolean(document.querySelector('.source-card__name'))
  `)
  check('the source file is shown', sourceShown)
  await shot(win, '11-convert-source')

  /* --- converting from the workspace ----------------------------------- */
  console.log('\n▶ converting from the workspace')
  const uiName = `clipforge-verify-ui-${Date.now()}`
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.tool__row .field')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set
      setter.call(input, ${JSON.stringify(uiName)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)
  await delay(300)
  await win.webContents.executeJavaScript(`
    (() => {
      const button = Array.from(document.querySelectorAll('.tool__foot .btn')).find(
        (b) => b.textContent.trim().startsWith('开始转换')
      )
      if (button) button.click()
    })()
  `)

  // The conversion runs in the background; give it time to finish.
  let uiStatus = ''
  for (let i = 0; i < 40; i++) {
    await delay(500)
    uiStatus = await win.webContents.executeJavaScript(
      `document.querySelector('.tool__col--tasks .task__status')?.textContent?.trim() ?? ''`
    )
    if (uiStatus === '完成' || uiStatus === '失败') break
  }
  check('the workspace converts the file', uiStatus === '完成', uiStatus)
  await shot(win, '11-convert-done')

  const downloads = await win.webContents.executeJavaScript(
    `window.clipforge.app.downloadsPath()`
  )
  const produced = path.join(downloads, `${uiName}.mp4`)
  if (fs.existsSync(produced)) {
    fs.unlinkSync(produced)
    check('the converted file is cleaned up', true)
  } else {
    check('the converted file was written', false, produced)
  }

  /* --- a real conversion ----------------------------------------------- */
  console.log('\n▶ converting a file')
  const outDir = os.tmpdir()
  const outName = `clipforge-verify-${Date.now()}`
  const out = path.join(outDir, `${outName}.mp4`)
  const converted = await win.webContents.executeJavaScript(
    `(async () => {
      const state = await new Promise((resolve) => {
        const off = window.clipforge.convert.onState((s) => {
          if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
            off()
            resolve(s)
          }
        })
        window.clipforge.convert
          .start({
            input: ${JSON.stringify(MEDIA[0])},
            outputDir: ${JSON.stringify(outDir)},
            fileName: ${JSON.stringify(outName)},
            format: 'mp4',
            videoCodec: 'libx264',
            audioCodec: 'aac',
            quality: 'medium'
          })
          .catch(() => undefined)
      })
      return { status: state.status, outputPath: state.outputPath, message: state.message }
    })()`
  )
  check(
    'the conversion finishes',
    converted.status === 'done',
    converted.message || converted.status
  )
  check('the output file exists', fs.existsSync(out), out)

  /* --- the other containers -------------------------------------------- */
  console.log('\n▶ the other containers')
  for (const format of ['mkv', 'webm', 'gif', 'mp3']) {
    const name = `clipforge-verify-${format}-${Date.now()}`
    const result = await win.webContents.executeJavaScript(
      `(async () => {
        const state = await new Promise((resolve) => {
          const off = window.clipforge.convert.onState((s) => {
            if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
              off()
              resolve(s)
            }
          })
          window.clipforge.convert
            .start({
              input: ${JSON.stringify(MEDIA[0])},
              outputDir: ${JSON.stringify(outDir)},
              fileName: ${JSON.stringify(name)},
              format: ${JSON.stringify(format)}
            })
            .catch(() => undefined)
        })
        return { status: state.status, message: state.message }
      })()`
    )
    const file = path.join(outDir, `${name}.${format}`)
    check(
      `it converts to ${format.toUpperCase()}`,
      result.status === 'done' && fs.existsSync(file),
      result.message
    )
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* the file is still held by the encoder */
      }
    }
  }

  /* --- the download workspace ------------------------------------------ */
  console.log('\n▶ the download workspace')
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.segmented--mode .segmented__item'))
      const download = buttons.find((b) => b.textContent.trim() === '下载')
      if (download) download.click()
    })()
  `)
  await delay(600)

  const hasDownload = await win.webContents.executeJavaScript(`
    Boolean(document.querySelector('.download__url-input'))
  `)
  check('the download workspace opens', hasDownload)

  const binary = await win.webContents.executeJavaScript(
    `window.clipforge.download.locate()`
  )

  if (!binary.available) {
    // Without yt-dlp installed the workspace has to say so, not crash.
    const banner = await win.webContents.executeJavaScript(`
      document.querySelector('.tool__banner')?.textContent?.trim() ?? ''
    `)
    check(
      'the missing binary is reported',
      banner.includes('yt-dlp'),
      banner.slice(0, 60)
    )
    await shot(win, '12-download-workspace')
  } else {
    console.log(`  (using ${binary.path} ${binary.version})`)

    // The file is written into a folder of the test's own, not wherever a
    // folder that was saved earlier may point to.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-tools-'))
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outDir] })
    await win.webContents.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.download__out .btn'))
        const pick = buttons.find((b) => b.textContent.trim() === '选择…')
        if (pick) pick.click()
      })()
    `)
    await delay(600)

    // Paste a link and read what it offers.
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('.download__url-input')
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set
        setter.call(input, 'https://example.com/watch?v=1')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await delay(300)
    await win.webContents.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.download__bar .btn'))
        const parse = buttons.find((b) => b.textContent.trim() === '解析')
        if (parse) parse.click()
      })()
    `)
    await delay(1500)

    const formats = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.qchip').length`
    )
    check('the link offers its renditions', formats > 0, `${formats} qualities`)
    await shot(win, '12-download-parsed')

    // Give the download a name of its own so the file can be cleaned up.
    const fileName = `clipforge-verify-${Date.now()}`
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('.dentry__name')
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        ).set
        setter.call(input, ${JSON.stringify(fileName)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })()
    `)
    await delay(300)
    await win.webContents.executeJavaScript(`
      (() => {
        const buttons = Array.from(document.querySelectorAll('.dentry__side .btn'))
        const go = buttons.find((b) => b.textContent.trim() === '加入队列')
        if (go) go.click()
      })()
    `)
    await delay(2500)

    const status = await win.webContents.executeJavaScript(`
      document.querySelector('.task__status')?.textContent?.trim() ?? ''
    `)
    check('the download finishes', status === '完成', status)
    await shot(win, '13-download-done')

    const produced = path.join(outDir, `${fileName}.mp4`)
    if (fs.existsSync(produced)) {
      fs.unlinkSync(produced)
      check('the downloaded file is cleaned up', true)
    } else {
      check('the downloaded file was written', false, produced)
    }
    fs.rmSync(outDir, { recursive: true, force: true })
  }

  /* --- back to the editor ---------------------------------------------- */
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.segmented--mode .segmented__item'))
      const edit = buttons.find((b) => b.textContent.trim() === '剪辑')
      if (edit) edit.click()
    })()
  `)
  await delay(600)
  const backToEdit = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.timeline'))`
  )
  check('the editor is still there afterwards', backToEdit)
  await shot(win, '14-back-to-edit')

  const realErrors = errors.filter((e) => !/DevTools|Autofill/i.test(e))
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`)
  app.exit(failures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
