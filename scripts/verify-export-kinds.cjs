/**
 * Feature check for the three kinds of export:
 *   1. 视频 — the composition as an MP4
 *   2. 音频 — the mix of the timeline as an MP3
 *   3. GIF  — the composition as an animated GIF
 *
 * It drives the real app and inspects the files FFmpeg produced.
 *
 *   npx electron scripts/verify-export-kinds.cjs
 */
const { app, BrowserWindow } = require('electron')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'testmedia', 'out')
const SHOTS = path.join(ROOT, 'shots')
const MEDIA = [
  path.join(ROOT, 'testmedia', 'clip-a.mp4'),
  path.join(ROOT, 'testmedia', 'music.m4a')
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

async function shot(win, name) {
  await delay(500)
  const image = await win.capturePage()
  fs.mkdirSync(SHOTS, { recursive: true })
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), image.toPNG())
  console.log(`  📸 ${name}.png`)
}

function ffprobe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,duration,nb_frames',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    file
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

async function exportAndWait(win, options) {
  await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const project = store.getState().project
      await window.clipforge.export.start(project, ${JSON.stringify(options)})
      return true
    })()`
  )

  return win.webContents.executeJavaScript(
    `(async () => {
      const deadline = Date.now() + 240000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 400))
        const s = window.__clipforgeEditor.getState().exportState
        if (s.status === 'done') return { status: 'done', log: s.log.slice(-4) }
        if (s.status === 'error') return { status: 'error', message: s.message, log: s.log.slice(-14) }
      }
      return { status: 'timeout' }
    })()`
  )
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

  /* --- a timeline with a picture and a sound --------------------------- */
  console.log('\n▶ building a timeline')
  const built = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const assets = await window.clipforge.media.importPaths(${JSON.stringify(MEDIA)})
      store.getState().addAssets(assets)
      const s = store.getState()
      s.insertClip(assets[0].id, 't_video_1', 0)
      const audioTrack = s.project.tracks.find(t => t.kind === 'audio')
      s.insertClip(assets[1].id, audioTrack.id, 0)
      const tracks = store.getState().project.tracks.map(t => ({
        kind: t.kind,
        clips: t.clips.map(c => ({ id: c.id, start: c.start, duration: c.duration }))
      }))
      return { tracks, duration: store.getState().project.tracks.flatMap(t => t.clips).reduce((m, c) => Math.max(m, c.start + c.duration), 0) }
    })()`
  )
  await delay(2000)
  console.log(`  ${JSON.stringify(built.tracks)}`)

  /* --- 1. the video export --------------------------------------------- */
  console.log('\n▶ 视频导出')
  fs.mkdirSync(OUT, { recursive: true })
  const videoPath = path.join(OUT, 'export-video.mp4')
  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath)
  const video = await exportAndWait(win, {
    path: videoPath,
    kind: 'video',
    preset: 'web'
  })
  if (video.status !== 'done') {
    console.error(video.message ?? '')
    ;(video.log ?? []).forEach((l) => console.error('   ', l))
  }
  check('the video export finished', video.status === 'done', video.status)
  if (video.status === 'done') {
    const info = ffprobe(videoPath)
    const streams = info.streams || []
    const hasVideo = streams.some((s) => s.codec_type === 'video')
    const hasAudio = streams.some((s) => s.codec_type === 'audio')
    check('the file carries a picture', hasVideo)
    check('the file carries the sound', hasAudio)
    const duration = Number(info.format.duration)
    check(
      'the file is as long as the timeline',
      Math.abs(duration - built.duration) < 0.5,
      `${duration.toFixed(2)}s vs ${built.duration.toFixed(2)}s`
    )
    console.log(`  ${(Number(info.format.size) / 1024).toFixed(0)} KB`)
  }

  /* --- 2. the audio export --------------------------------------------- */
  console.log('\n▶ 音频导出')
  const audioPath = path.join(OUT, 'export-audio.mp3')
  if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
  const audio = await exportAndWait(win, {
    path: audioPath,
    kind: 'audio',
    preset: 'web',
    audioFormat: 'mp3'
  })
  if (audio.status !== 'done') {
    console.error(audio.message ?? '')
    ;(audio.log ?? []).forEach((l) => console.error('   ', l))
  }
  check('the audio export finished', audio.status === 'done', audio.status)
  if (audio.status === 'done') {
    const info = ffprobe(audioPath)
    const streams = info.streams || []
    check('the file has no picture', !streams.some((s) => s.codec_type === 'video'))
    const sound = streams.find((s) => s.codec_type === 'audio')
    check('the file carries sound', !!sound, sound ? sound.codec_name : '')
    check('the sound is mp3', sound?.codec_name === 'mp3', sound?.codec_name ?? '')
    const duration = Number(info.format.duration)
    check(
      'the sound is as long as the timeline',
      Math.abs(duration - built.duration) < 0.5,
      `${duration.toFixed(2)}s vs ${built.duration.toFixed(2)}s`
    )
    console.log(`  ${(Number(info.format.size) / 1024).toFixed(0)} KB`)
  }

  /* --- 3. the GIF export ------------------------------------------------ */
  console.log('\n▶ GIF 导出')
  const gifPath = path.join(OUT, 'export.gif')
  if (fs.existsSync(gifPath)) fs.unlinkSync(gifPath)
  const gif = await exportAndWait(win, {
    path: gifPath,
    kind: 'gif',
    preset: 'web',
    gif: { width: 320, fps: 10, loop: 0, dither: 'bayer' }
  })
  if (gif.status !== 'done') {
    console.error(gif.message ?? '')
    ;(gif.log ?? []).forEach((l) => console.error('   ', l))
  }
  check('the GIF export finished', gif.status === 'done', gif.status)
  if (gif.status === 'done') {
    const info = ffprobe(gifPath)
    const streams = info.streams || []
    const picture = streams.find((s) => s.codec_type === 'video')
    check('the file is a GIF', picture?.codec_name === 'gif', picture?.codec_name ?? '')
    check('the picture is 320 wide', picture?.width === 320, `${picture?.width}px`)
    const frames = Number(picture?.nb_frames ?? 0)
    check('the GIF holds frames', frames > 0, `${frames} frames`)
    check(
      'the GIF is as long as the timeline',
      Math.abs(Number(info.format.duration) - built.duration) < 0.6,
      `${Number(info.format.duration).toFixed(2)}s vs ${built.duration.toFixed(2)}s`
    )
    console.log(`  ${(Number(info.format.size) / 1024).toFixed(0)} KB`)
  }

  /* --- 4. the dialog offers the three kinds ---------------------------- */
  console.log('\n▶ 导出对话框')
  // The dialog shows the progress view while a run is remembered, so the
  // state is put back to idle first.
  await win.webContents.executeJavaScript(
    `(() => {
      window.__clipforgeEditor.getState().setExportState({
        status: 'idle',
        progress: { progress: 0, outTime: 0, duration: 0, speed: '', fps: 0, bitrate: '', totalSize: '', eta: '' },
        message: '',
        log: []
      })
      const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '导出')
      button.click()
      return true
    })()`
  )
  await delay(600)

  const dialog = await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.dialog')
      const kinds = Array.from(el.querySelectorAll('.preset')).map(b => b.querySelector('.preset__label').textContent.trim())
      return { title: el.querySelector('.dialog__title').textContent.trim(), kinds }
    })()`
  )
  check('the dialog offers video, audio and GIF', dialog.kinds.slice(0, 3).join('/') === '视频/音频/GIF', dialog.kinds.slice(0, 3).join('/'))
  await shot(win, '23-export-dialog')

  // The audio tab.
  await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.dialog')
      const button = Array.from(el.querySelectorAll('.preset')).find(b => b.querySelector('.preset__label').textContent.trim() === '音频')
      button.click()
      return true
    })()`
  )
  await delay(400)
  const audioTab = await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.dialog')
      return {
        title: el.querySelector('.dialog__title').textContent.trim(),
        formats: Array.from(el.querySelectorAll('.preset__label')).map(n => n.textContent.trim())
      }
    })()`
  )
  check('the audio tab offers the containers', audioTab.formats.includes('MP3') && audioTab.formats.includes('FLAC'), audioTab.formats.join('/'))
  await shot(win, '24-export-audio')

  // The GIF tab.
  await win.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector('.dialog')
      const button = Array.from(el.querySelectorAll('.preset')).find(b => b.querySelector('.preset__label').textContent.trim() === 'GIF')
      button.click()
      return true
    })()`
  )
  await delay(400)
  await shot(win, '25-export-gif')

  await win.webContents.executeJavaScript(
    `(() => {
      const button = Array.from(document.querySelectorAll('.dialog button')).find(b => b.getAttribute('aria-label') === '关闭')
      button.click()
      return true
    })()`
  )
  await delay(300)

  /* --- 5. an empty timeline says so ------------------------------------ */
  console.log('\n▶ 没有声音时导出音频')
  const silent = await win.webContents.executeJavaScript(
    `(async () => {
      const store = window.__clipforgeEditor
      const project = JSON.parse(JSON.stringify(store.getState().project))
      for (const track of project.tracks) track.clips = []
      await window.clipforge.export.start(project, {
        path: ${JSON.stringify(path.join(OUT, 'silent.mp3'))},
        kind: 'audio',
        preset: 'web',
        audioFormat: 'mp3'
      })
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200))
        const s = window.__clipforgeEditor.getState().exportState
        if (s.status === 'error') return { status: 'error', message: s.message }
        if (s.status === 'done') return { status: 'done' }
      }
      return { status: 'timeout' }
    })()`
  )
  check('a silent timeline is refused', silent.status === 'error', silent.message ?? '')

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
