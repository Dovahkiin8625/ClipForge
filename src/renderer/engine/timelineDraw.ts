import type { Asset, Clip, Project, Track } from '@shared/types'
import { clipSourceDuration } from '@shared/speed'
import { clipEnd } from './timeline'

/**
 * Canvas rendering for the timeline.
 *
 * The timeline is split into two layers:
 *   • the static layer holds the ruler, the track lanes and the clips. It is
 *     only redrawn when the document, the zoom or the scroll position change.
 *   • the dynamic layer holds the playhead, the selection outlines and any
 *     in-flight drag. It is redrawn every frame while something is moving.
 *
 * Keeping them apart is what makes the timeline feel instant: dragging a
 * clip never re-blits a single thumbnail.
 */

export const TL = {
  rulerH: 26,
  trackH: 62,
  labelH: 15,
  sprocketH: 5,
  cellW: 54,
  edgeGrab: 7,
  keyframeH: 9
}

export interface Palette {
  void: string
  deck: string
  deck2: string
  deck3: string
  line: string
  line2: string
  ink: string
  ink2: string
  ink3: string
  ink4: string
  splice: string
  spliceHi: string
  signal: string
  audio: string
  clipVideo: string
  clipAudio: string
  band: string
  hole: string
}

let cachedPalette: Palette | null = null

export function palette(): Palette {
  if (cachedPalette) return cachedPalette
  const styles = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback
  cachedPalette = {
    void: v('--void', '#0b0e13'),
    deck: v('--deck', '#12161d'),
    deck2: v('--deck-2', '#171d26'),
    deck3: v('--deck-3', '#1e2531'),
    line: v('--line', '#212936'),
    line2: v('--line-2', '#2d3745'),
    ink: v('--ink', '#e7ebf1'),
    ink2: v('--ink-2', '#7a8499'),
    ink3: v('--ink-3', '#525c6e'),
    ink4: v('--ink-4', '#3c4553'),
    splice: v('--splice', '#f2a03d'),
    spliceHi: v('--splice-hi', '#ffbe68'),
    signal: v('--signal', '#3fd9c0'),
    audio: v('--audio', '#9b87f5'),
    clipVideo: '#1a212e',
    clipAudio: '#191d2b',
    band: '#2a3344',
    hole: '#0e1218'
  }
  return cachedPalette
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function timeToX(time: number, pxPerSecond: number, scrollX: number): number {
  return time * pxPerSecond - scrollX
}

export function xToTime(x: number, pxPerSecond: number, scrollX: number): number {
  return (x + scrollX) / pxPerSecond
}

/** Picks a ruler tick interval that keeps labels legible at the current zoom. */
export function tickInterval(pxPerSecond: number, fps: number): number {
  const frame = 1 / fps
  const candidates = [
    frame,
    frame * 2,
    frame * 5,
    frame * 10,
    0.5,
    1,
    2,
    5,
    10,
    15,
    30,
    60,
    120,
    300,
    600,
    1800
  ]
  for (const c of candidates) {
    if (c * pxPerSecond >= 74) return c
  }
  return 3600
}

function formatRulerLabel(seconds: number, interval: number): string {
  if (interval < 1) {
    const frames = Math.round(seconds * 30)
    return `${String(Math.floor(frames / 30)).padStart(2, '0')}:${String(frames % 30).padStart(2, '0')}`
  }
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Formats seconds as HH:MM:SS:FF (frames). */
export function formatTimecode(seconds: number, fps: number): string {
  const safe = Math.max(0, seconds)
  const totalFrames = Math.round(safe * fps)
  const frames = totalFrames % Math.round(fps)
  const totalSeconds = Math.floor(totalFrames / Math.round(fps))
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(frames)}`
}

/** Formats a duration as M:SS. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/* ------------------------------------------------------------------ */
/* Static layer                                                        */
/* ------------------------------------------------------------------ */

export interface StaticParams {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  scrollX: number
  scrollY: number
  pxPerSecond: number
  project: Project
  selected: Set<string>
  images: Map<string, HTMLImageElement>
  showWaveforms: boolean
}

export function drawStatic(p: StaticParams): void {
  const { ctx, width, height } = p
  const pal = palette()

  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = pal.deck
  ctx.fillRect(0, 0, width, height)

  drawTrackLanes(p, pal)
  drawGrid(p, pal)
  drawClips(p, pal)
  drawRuler(p, pal)
}

function drawTrackLanes(p: StaticParams, pal: Palette): void {
  const { ctx, height, project, scrollY } = p
  project.tracks.forEach((track, index) => {
    const y = TL.rulerH + index * TL.trackH - scrollY
    if (y + TL.trackH < TL.rulerH || y > height) return

    ctx.fillStyle =
      track.kind === 'audio' ? 'rgba(155,135,245,0.028)' : 'rgba(255,255,255,0.012)'
    ctx.fillRect(0, y, p.width, TL.trackH)

    ctx.fillStyle = pal.line
    ctx.fillRect(0, y + TL.trackH - 1, p.width, 1)
  })
}

function drawGrid(p: StaticParams, pal: Palette): void {
  const { ctx, width, height, project, pxPerSecond, scrollX } = p
  const interval = tickInterval(pxPerSecond, project.settings.fps)
  const first = Math.floor((scrollX / pxPerSecond) / interval) * interval

  ctx.fillStyle = 'rgba(255,255,255,0.028)'
  for (let t = first; ; t += interval) {
    const x = Math.round(timeToX(t, pxPerSecond, scrollX))
    if (x > width) break
    if (x < 0) continue
    ctx.fillRect(x, TL.rulerH, 1, height - TL.rulerH)
  }
}

function drawRuler(p: StaticParams, pal: Palette): void {
  const { ctx, width, project, pxPerSecond, scrollX } = p
  const interval = tickInterval(pxPerSecond, project.settings.fps)
  const first = Math.floor((scrollX / pxPerSecond) / interval) * interval

  ctx.fillStyle = pal.deck
  ctx.fillRect(0, 0, width, TL.rulerH)
  ctx.fillStyle = pal.line
  ctx.fillRect(0, TL.rulerH - 1, width, 1)

  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.textBaseline = 'middle'

  for (let t = first; ; t += interval) {
    const x = Math.round(timeToX(t, pxPerSecond, scrollX))
    if (x > width) break
    if (x < -40) continue

    ctx.fillStyle = pal.ink4
    ctx.fillRect(x, TL.rulerH - 6, 1, 6)
    ctx.fillStyle = pal.ink3
    ctx.textAlign = 'left'
    ctx.fillText(formatRulerLabel(t, interval), x + 4, TL.rulerH / 2 - 1)
  }
}

/* ------------------------------------------------------------------ */
/* Clips                                                               */
/* ------------------------------------------------------------------ */

function drawClips(p: StaticParams, pal: Palette): void {
  const { project, pxPerSecond, scrollX, scrollY, height } = p
  project.tracks.forEach((track, index) => {
    const y = TL.rulerH + index * TL.trackH - scrollY
    if (y + TL.trackH < TL.rulerH || y > height) return
    for (const clip of track.clips) {
      const x = timeToX(clip.start, pxPerSecond, scrollX)
      const w = clip.duration * pxPerSecond
      if (x + w < -4 || x > p.width + 4) continue
      const asset = project.assets[clip.assetId]
      if (!asset) continue
      drawClip(p, pal, track, clip, asset, x, y + 1, w, TL.trackH - 2)
    }
  })
}

function drawClip(
  p: StaticParams,
  pal: Palette,
  track: Track,
  clip: Clip,
  asset: Asset,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const { ctx, selected } = p
  if (w < 1) return

  const isSelected = selected.has(clip.id)
  const isAudio = track.kind === 'audio'

  ctx.save()
  ctx.beginPath()
  roundRect(ctx, x, y, w, h, 2)
  ctx.clip()

  // --- body -----------------------------------------------------------
  ctx.fillStyle = isAudio ? pal.clipAudio : pal.clipVideo
  ctx.fillRect(x, y, w, h)

  const bodyTop = y + TL.labelH
  const bodyH = h - TL.labelH

  // --- content --------------------------------------------------------
  if (isAudio) {
    drawWaveform(p, pal, clip, asset, x, bodyTop, w, bodyH)
  } else {
    drawFilmstrip(p, pal, clip, asset, x, bodyTop, w, bodyH)
  }

  // --- top band -------------------------------------------------------
  if (isAudio) {
    ctx.fillStyle = 'rgba(155,135,245,0.5)'
    ctx.fillRect(x, y, w, 2)
  } else {
    drawSprockets(ctx, pal, x, y, w, TL.sprocketH)
  }

  // --- label ----------------------------------------------------------
  ctx.fillStyle = 'rgba(10,13,18,0.72)'
  ctx.fillRect(x, y + (isAudio ? 2 : TL.sprocketH), w, TL.labelH - (isAudio ? 2 : 0))

  ctx.font = '10.5px "IBM Plex Sans", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = isSelected ? pal.ink : pal.ink2
  const labelY = y + (isAudio ? 2 : TL.sprocketH) + (TL.labelH - (isAudio ? 2 : 0)) / 2
  const label = clip.label ?? asset.name
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 5, y, w - 10, TL.labelH)
  ctx.clip()
  ctx.fillText(label, x + 5, labelY)
  ctx.restore()

  // --- keyframe markers ----------------------------------------------
  drawKeyframes(p, pal, clip, x, y + h - TL.keyframeH, w)

  ctx.restore()

  // --- border ---------------------------------------------------------
  ctx.save()
  ctx.beginPath()
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 2)
  if (isSelected) {
    ctx.strokeStyle = pal.signal
    ctx.lineWidth = 1.5
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'
    ctx.lineWidth = 1
  }
  ctx.stroke()
  ctx.restore()
}

function drawSprockets(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  x: number,
  y: number,
  w: number,
  bandH: number
): void {
  ctx.fillStyle = pal.band
  ctx.fillRect(x, y, w, bandH)
  ctx.fillStyle = pal.hole
  const pitch = 11
  const holeW = 5
  const holeH = Math.max(2, bandH - 2)
  const first = Math.floor(x / pitch) * pitch
  for (let hx = first; hx < x + w; hx += pitch) {
    ctx.beginPath()
    roundRect(ctx, hx + 3, y + 1, holeW, holeH, 1)
    ctx.fill()
  }
}

function drawFilmstrip(
  p: StaticParams,
  pal: Palette,
  clip: Clip,
  asset: Asset,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const { ctx, images } = p
  const sprite = asset.sprite
  const img = sprite ? images.get(sprite.url) : undefined

  if (!sprite || !img || !img.complete || img.naturalWidth === 0) {
    // Placeholder: a soft diagonal hatch that still reads as "film".
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.fillStyle = 'rgba(255,255,255,0.022)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = -h; i < w; i += 9) {
      ctx.moveTo(x + i, y + h)
      ctx.lineTo(x + i + h, y)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  const cells = Math.max(1, Math.ceil(w / TL.cellW))
  const cellW = w / cells
  const srcDur = clipSourceDuration(clip)
  const srcStart = clip.inPoint

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  for (let i = 0; i < cells; i++) {
    const sourceTime = srcStart + ((i + 0.5) / cells) * srcDur
    let idx = Math.floor((sourceTime - sprite.startTime) / sprite.interval)
    if (idx < 0) idx = 0
    if (idx >= sprite.count) idx = sprite.count - 1

    const col = idx % sprite.cols
    const row = Math.floor(idx / sprite.cols)
    const sx = col * sprite.frameWidth
    const sy = row * sprite.frameHeight
    const sw = sprite.frameWidth
    const sh = sprite.frameHeight
    if (sx + sw > img.naturalWidth || sy + sh > img.naturalHeight) continue

    const dx = x + i * cellW
    const dw = Math.ceil(cellW)
    ctx.drawImage(img, sx, sy, sw, sh, dx, y, dw, h)
  }

  // A hairline between cells keeps the strip legible when zoomed out.
  ctx.fillStyle = 'rgba(10,13,18,0.35)'
  for (let i = 1; i < cells; i++) {
    ctx.fillRect(Math.round(x + i * cellW), y, 1, h)
  }

  // A soft scrim at the bottom so the keyframe strip stays readable.
  const grad = ctx.createLinearGradient(0, y + h - 18, 0, y + h)
  grad.addColorStop(0, 'rgba(10,13,18,0)')
  grad.addColorStop(1, 'rgba(10,13,18,0.55)')
  ctx.fillStyle = grad
  ctx.fillRect(x, y + h - 18, w, 18)
  ctx.restore()
}

function drawWaveform(
  p: StaticParams,
  pal: Palette,
  clip: Clip,
  asset: Asset,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const { ctx } = p
  const peaks = asset.waveform

  if (!peaks || peaks.length === 0) {
    ctx.fillStyle = 'rgba(155,135,245,0.16)'
    ctx.fillRect(x, y + h / 2 - 1, w, 2)
    return
  }

  const bucketsPerSec = asset.duration > 0 ? peaks.length / asset.duration : 200
  const srcStart = clip.inPoint
  const srcEnd = clip.inPoint + clipSourceDuration(clip)
  const mid = y + h / 2
  const half = (h / 2) * 0.86

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  ctx.strokeStyle = pal.audio
  ctx.globalAlpha = 0.78
  ctx.lineWidth = 1
  ctx.beginPath()

  const columns = Math.max(1, Math.floor(w))
  for (let i = 0; i < columns; i++) {
    const t0 = srcStart + ((i / columns) * (srcEnd - srcStart))
    const t1 = srcStart + (((i + 1) / columns) * (srcEnd - srcStart))
    const b0 = Math.max(0, Math.floor(t0 * bucketsPerSec))
    const b1 = Math.min(peaks.length - 1, Math.max(b0, Math.ceil(t1 * bucketsPerSec) - 1))

    let peak = 0
    for (let b = b0; b <= b1; b++) {
      const v = peaks[b]
      if (v > peak) peak = v
    }

    const amp = peak * half
    const px = x + i + 0.5
    ctx.moveTo(px, mid - amp)
    ctx.lineTo(px, mid + amp)
  }
  ctx.stroke()

  ctx.globalAlpha = 1
  ctx.fillStyle = 'rgba(10,13,18,0.4)'
  ctx.fillRect(x, mid - 0.5, w, 1)
  ctx.restore()
}

function drawKeyframes(
  p: StaticParams,
  pal: Palette,
  clip: Clip,
  x: number,
  y: number,
  w: number
): void {
  const { ctx, pxPerSecond, scrollX } = p
  const times: number[] = []
  for (const list of Object.values(clip.keyframes)) {
    for (const k of list) times.push(clip.start + k.t)
  }
  if (times.length === 0) return

  ctx.save()
  ctx.fillStyle = pal.splice
  for (const t of times) {
    const kx = timeToX(t, pxPerSecond, scrollX)
    if (kx < x - 6 || kx > x + w + 6) continue
    ctx.save()
    ctx.translate(kx, y + TL.keyframeH / 2)
    ctx.rotate(Math.PI / 4)
    ctx.fillRect(-3, -3, 6, 6)
    ctx.restore()
  }
  ctx.restore()
}

/* ------------------------------------------------------------------ */
/* Dynamic layer                                                       */
/* ------------------------------------------------------------------ */

export interface DragPreview {
  kind: 'move' | 'trim-start' | 'trim-end'
  clipId: string
  start: number
  duration: number
  trackIndex: number
}

export interface DynamicParams {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  scrollX: number
  scrollY: number
  pxPerSecond: number
  project: Project
  playhead: number
  selected: Set<string>
  drag: DragPreview | null
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  snapGuide: number | null
  hoveredId: string | null
}

export function drawDynamic(p: DynamicParams): void {
  const { ctx, width, height } = p
  ctx.clearRect(0, 0, width, height)

  if (p.marquee) drawMarquee(p)
  if (p.drag) drawDragPreview(p)
  drawPlayhead(p)
}

function drawMarquee(p: DynamicParams): void {
  const { ctx } = p
  const m = p.marquee!
  const x = Math.min(m.x0, m.x1)
  const y = Math.min(m.y0, m.y1)
  const w = Math.abs(m.x1 - m.x0)
  const h = Math.abs(m.y1 - m.y0)
  ctx.fillStyle = 'rgba(63,217,192,0.08)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(63,217,192,0.6)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w, h)
}

function drawDragPreview(p: DynamicParams): void {
  const { ctx, project, pxPerSecond, scrollX, scrollY } = p
  const drag = p.drag!
  const pal = palette()
  if (!project.tracks[drag.trackIndex]) return

  // The clip may be travelling to another track, so it is looked up in the
  // whole document rather than in the lane it is being dropped on.
  const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === drag.clipId)
  if (!clip) return

  const x = timeToX(drag.start, pxPerSecond, scrollX)
  const w = drag.duration * pxPerSecond
  const y = TL.rulerH + drag.trackIndex * TL.trackH - scrollY + 1
  const h = TL.trackH - 2

  ctx.save()
  ctx.beginPath()
  roundRect(ctx, x, y, w, h, 2)
  ctx.fillStyle = 'rgba(63,217,192,0.12)'
  ctx.fill()
  ctx.strokeStyle = pal.signal
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Show the dragged clip's name so the user can confirm what is moving.
  ctx.font = '10.5px "IBM Plex Sans", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = pal.ink
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 4, y, Math.max(0, w - 8), h)
  ctx.clip()
  ctx.fillText(clip.label ?? '', x + 6, y + 10)
  ctx.restore()
  ctx.restore()
}

function drawPlayhead(p: DynamicParams): void {
  const { ctx, width, height, playhead, pxPerSecond, scrollX } = p
  const pal = palette()
  const x = Math.round(timeToX(playhead, pxPerSecond, scrollX))
  if (x < -2 || x > width + 2) return

  ctx.fillStyle = pal.splice
  ctx.fillRect(x, 0, 1, height)

  // The head: a small tapered flag that reads as a grease-pencil mark.
  ctx.beginPath()
  ctx.moveTo(x - 6, 0)
  ctx.lineTo(x + 7, 0)
  ctx.lineTo(x + 7, 12)
  ctx.lineTo(x + 0.5, 18)
  ctx.lineTo(x - 6, 12)
  ctx.closePath()
  ctx.fillStyle = pal.splice
  ctx.fill()
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
}

export { clipEnd }
