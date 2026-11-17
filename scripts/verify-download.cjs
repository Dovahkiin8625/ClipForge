/**
 * Checks the download workspace.
 *
 * The link is read, the page is shown as a list, the qualities are read
 * for one entry and the file is written. A stand-in for yt-dlp answers so
 * that the whole way can be walked without a network connection.
 *
 *   npm run build && npm run verify:download
 */
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'shots')

process.chdir(ROOT)
// The stand-in answers the same calls the real binary does.
if (!process.env['CLIPFORGE_YTDLP']) {
  process.env['CLIPFORGE_YTDLP'] = 'node scripts/mock-ytdlp.cjs'
}

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

/**
 * Waits for the qualities of a row to show up.
 */
async function waitForChips(win, count, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs
  let chips = 0
  while (Date.now() < until) {
    chips = await win.webContents.executeJavaScript(
          )
    if (chips >= count) return chips
    await delay(200)
  }
  return chips
}

/** Puts a link into the field and asks for it to be read. */
async function parse(win, link) {
  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('.download__url-input')
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set
      setter.call(input, ${JSON.stringify(link)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()
  `)
  await delay(200)
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.download__bar .btn'))
      const go = buttons.find((b) => b.textContent.trim() === '解析')
      if (go) go.click()
    })()
  `)
  await delay(1200)
}

/**
 * Waits for the list to hold a number of rows.
 *
 * Reading a link can take a while: a page the extractor cannot make
 * sense of is read by hand, and that takes a moment.
 */
async function waitForRows(win, count, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs
  let rows = 0
  while (Date.now() < until) {
    rows = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.dentry').length`
    )
    if (rows === count) return rows
    await delay(200)
  }
  return rows
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

  // Into the download workspace.
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.segmented--mode .segmented__item'))
      const download = buttons.find((b) => b.textContent.trim() === '下载')
      if (download) download.click()
      return Boolean(download)
    })()
  `)
  await delay(600)

  check(
    'the download workspace opens',
    await win.webContents.executeJavaScript(
      `Boolean(document.querySelector('.download__url-input'))`
    )
  )

  // The tasks that are already in the list are left alone; only the ones
  // this run adds are looked at.
  const before = await win.webContents.executeJavaScript(
    `(async () => (await window.clipforge.download.tasks()).map((t) => t.id))()`
  )

  // The settings of an earlier run must not decide what this one does.
  await win.webContents.executeJavaScript(
    `window.clipforge.download.saveSettings({ maxParallel: 2, retries: 1 })`
  )
  await delay(300)

  /* --- one video ------------------------------------------------------- */
  console.log('\n▶ one video')
  await parse(win, 'https://mock/video')
  await waitForRows(win, 1)
  await waitForChips(win, 1)

  const single = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('.dentry')
      const active = document.querySelector('.qchip.is-active')
      return {
        rows: rows.length,
        quality: active?.querySelector('.qchip__label')?.textContent?.trim() ?? '',
        id: active?.getAttribute('title') ?? ''
      }
    })()
  `)
  check('the link shows one entry', single.rows === 1, `${single.rows} entries`)
  check(
    'the first quality carries sound',
    single.quality.includes('有声'),
    single.quality
  )
  check(
    'the quality takes a picture and a sound',
    single.id.includes('+'),
    single.id
  )
  await shot(win, '20-download-one')

  /* --- a page with several videos -------------------------------------- */
  console.log('\n▶ a page with several videos')
  await parse(win, 'https://mock/playlist')
  const rows = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.dentry').length`
  )
  check('the page shows every entry', rows === 3, `${rows} entries`)

  // The second entry is read, and its qualities are on offer.
  await delay(1500)

  const second = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelectorAll('.dentry')[1]
      const chips = Array.from(row?.querySelectorAll('.qchip') ?? [])
      const labels = chips.map(
        (n) => n.querySelector('.qchip__label')?.textContent?.trim() ?? ''
      )
      return { count: chips.length, labels }
    })()
  `)
  check(
    'the qualities of the entry are read',
    second.count > 1,
    `${second.count} qualities`
  )
  check(
    'the choices say whether they carry sound',
    second.labels.some((l) => l.includes('有声')),
    second.labels.slice(0, 3).join(' / ')
  )
  await shot(win, '21-download-list')

  /* --- a link that answers with the video alone ------------------------ */
  console.log('\n▶ a link that holds one video')
  await parse(win, 'https://mock/flat')
  await waitForRows(win, 1)
  await waitForChips(win, 1)

  const lone = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('.dentry')
      const active = document.querySelector('.qchip.is-active')
      return {
        rows: rows.length,
        quality: active?.querySelector('.qchip__label')?.textContent?.trim() ?? ''
      }
    })()
  `)
  check('the video is shown', lone.rows === 1, `${lone.rows} entries`)
  check(
    'its qualities are read on demand',
    lone.quality.includes('有声'),
    lone.quality
  )

  /* --- the settings ---------------------------------------------------- */
  console.log('\n▶ the settings')
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.tool__head .btn'))
      const open = buttons.find((b) => b.textContent.trim() === '设置')
      if (open) open.click()
      return Boolean(open)
    })()
  `)
  await delay(400)

  const settings = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('.download__setting')
      const browser = document.querySelector('.download__settings select')
      return { rows: rows.length, browsers: browser?.options.length ?? 0 }
    })()
  `)
  check(
    'the settings can be opened',
    settings.rows >= 5,
    `${settings.rows} rows`
  )
  check(
    'the browsers are on offer',
    settings.browsers > 3,
    `${settings.browsers} choices`
  )
  await shot(win, '23-download-settings')

  /* --- the download ---------------------------------------------------- */
  console.log('\n▶ the download')
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-dl-'))
  const fileName = `clipforge-verify-${Date.now()}`

  // The file is written where the test says, not into the downloads folder.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [outDir] })
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.download__out .btn'))
      const pick = buttons.find((b) => b.textContent.trim() === '选择…')
      if (pick) pick.click()
      return Boolean(pick)
    })()
  `)
  await delay(800)

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
      return Boolean(go)
    })()
  `)
  await delay(600)

  const added = await win.webContents.executeJavaScript(`
    (async () => {
      const tasks = await window.clipforge.download.tasks()
      const before = new Set(${JSON.stringify(before)})
      return tasks
        .filter((t) => !before.has(t.id))
        .map((t) => ({ id: t.id, status: t.status, path: t.outputPath ?? '' }))
    })()
  `)
  check('the entry goes into the queue', added.length === 1, `${added.length} tasks`)

  // The stand-in writes the file a moment later.
  let status = ''
  for (let i = 0; i < 40; i++) {
    await delay(250)
    const fresh = await win.webContents.executeJavaScript(`
      (async () => {
        const tasks = await window.clipforge.download.tasks()
        const before = new Set(${JSON.stringify(before)})
        const mine = tasks.filter((t) => !before.has(t.id))
        return mine.length ? mine[0].status : ''
      })()
    `)
    status = fresh
    if (status === 'done' || status === 'error' || status === 'cancelled') break
  }
  check('the download finishes', status === 'done', status)
  await shot(win, '22-download-done')

  const produced = path.join(outDir, `${fileName}.mp4`)
  check(
    'the file is written where it was asked for',
    fs.existsSync(produced),
    produced
  )

  // The entry in the list has to point at the file, or "open" and "reveal"
  // would quietly do nothing.
  const task = await win.webContents.executeJavaScript(`
    (async () => {
      const tasks = await window.clipforge.download.tasks()
      const before = new Set(${JSON.stringify(before)})
      const mine = tasks.filter((t) => !before.has(t.id))
      return mine.length ? mine[0].outputPath ?? '' : ''
    })()
  `)
  check('the entry points at the file', task === produced, task || '(empty)')

  if (fs.existsSync(produced)) fs.unlinkSync(produced)
  fs.rmSync(outDir, { recursive: true, force: true })

  /* --- two at a time ---------------------------------------------------- */
  console.log('\n▶ two at a time')
  await parse(win, 'https://mock/playlist')
  await waitForRows(win, 3)

  const startMany = await win.webContents.executeJavaScript(`
    (async () => {
      const before = new Set(
        (await window.clipforge.download.tasks()).map((t) => t.id)
      )
      const rows = document.querySelectorAll('.dentry__side .btn')
      for (const button of rows) button.click()
      await new Promise((r) => setTimeout(r, 300))
      const tasks = await window.clipforge.download.tasks()
      return {
        before: [...before],
        added: tasks.filter((t) => !before.has(t.id)).length
      }
    })()
  `)
  check('three entries go into the queue', startMany.added === 3, `${startMany.added} added`)

  // Two of them should be running at the same time.
  let peak = 0
  for (let i = 0; i < 60; i++) {
    const running = await win.webContents.executeJavaScript(`
      (async () => {
        const tasks = await window.clipforge.download.tasks()
        return tasks.filter((t) => t.status === 'running').length
      })()
    `)
    if (running > peak) peak = running
    if (peak >= 2) break
    await delay(50)
  }
  check('two downloads run at the same time', peak >= 2, `${peak} at once`)

  /* --- a failure that says what to do ----------------------------------- */
  console.log('\n▶ a failure')
  await parse(win, 'https://mock/fail-auth')
  await waitForRows(win, 1)
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.dentry__side .btn'))
      const go = buttons.find((b) => b.textContent.trim() === '加入队列')
      if (go) go.click()
    })()
  `)
  await delay(2500)

  const failure = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.task--error')
      return {
        hint: row?.querySelector('.task__failure-text')?.textContent?.trim() ?? '',
        actions: row?.querySelectorAll('.task__failure .btn').length ?? 0
      }
    })()
  `)
  check(
    'the failure says what to do',
    failure.hint.includes('登录'),
    failure.hint || '(nothing)'
  )
  check(
    'the failure offers a way out',
    failure.actions > 0,
    `${failure.actions} buttons`
  )
  await shot(win, '24-download-failed')

  /* --- a page that hides its players in a JSON blob -------------------- */
  console.log('\n▶ a page that hides its players')
  // A page of its own: the streams are in it, but the extractor cannot
  // see them, and the workspace has to read the page by hand.
  const fixture = fs.readFileSync(
    path.join(ROOT, 'scripts', 'fixtures', 'page-with-players.html'),
    'utf8'
  )
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fixture)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  await parse(win, `http://127.0.0.1:${port}/archives/3156/`)
  await waitForRows(win, 3)

  const hidden = await win.webContents.executeJavaScript(`
    (() => {
      const rows = document.querySelectorAll('.dentry')
      const chips = Array.from(rows[0]?.querySelectorAll('.qchip') ?? []).map(
        (n) => n.querySelector('.qchip__label')?.textContent?.trim() ?? ''
      )
      return {
        rows: rows.length,
        chips,
        title: rows[0]?.querySelector('.dentry__title')?.textContent?.trim() ?? ''
      }
    })()
  `)
  check('the hidden streams are found', hidden.rows === 3, `${hidden.rows} entries`)
  check(
    'they are taken as they are',
    hidden.chips.includes('直链流'),
    hidden.chips.join(' / ')
  )
  check(
    'they carry the name of the page',
    hidden.title.includes('示例文章标题'),
    hidden.title
  )
  await shot(win, '25-download-hidden-streams')

  // The page can also be read by hand.
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.download__bar .btn'))
      const go = buttons.find((b) => b.textContent.trim() === '扫页面')
      if (go) go.click()
    })()
  `)
  await waitForRows(win, 3)
  const manual = await win.webContents.executeJavaScript(
    `document.querySelectorAll('.dentry').length`
  )
  check('the page can be read by hand too', manual === 3, `${manual} entries`)

  server.close()

  /* --- a broken connection is tried again ------------------------------- */
  console.log('\n▶ a broken connection')
  await parse(win, 'https://mock/fail-net')
  await waitForRows(win, 1)
  const beforeRetry = await win.webContents.executeJavaScript(
    `(async () => (await window.clipforge.download.tasks()).map((t) => t.id))()`
  )
  await win.webContents.executeJavaScript(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('.dentry__side .btn'))
      const go = buttons.find((b) => b.textContent.trim() === '加入队列')
      if (go) go.click()
    })()
  `)

  let retried = false
  let hint = ''
  for (let i = 0; i < 60; i++) {
    await delay(250)
    const state = await win.webContents.executeJavaScript(`
      (async () => {
        const before = new Set(${JSON.stringify(beforeRetry)})
        const tasks = await window.clipforge.download.tasks()
        const mine = tasks.filter((t) => !before.has(t.id))
        return mine.length ? mine[0].message : ''
      })()
    `)
    if (state.includes('重试')) {
      retried = true
      break
    }
    if (state.includes('网络')) {
      hint = state
      break
    }
  }
  check(
    'a broken connection is tried again',
    retried,
    hint || (retried ? 'the task was put back in the queue' : 'no retry')
  )

  const reported = errors.filter((m) => !/Autofill|DevTools/i.test(m))
  check('no errors in the window', reported.length === 0, reported[0] ?? '')

  console.log('')
  if (failures) {
    console.log(`❌ ${failures} check(s) failed`)
    app.exit(1)
  } else {
    console.log('✅ the download workspace is sound')
    app.exit(0)
  }
}

run().catch((err) => {
  console.error(err)
  app.exit(1)
})
