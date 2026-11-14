import type { Asset, Clip, Project, Track } from '@shared/types'
import { rateAtOffset } from '@shared/speed'
import { isNeutral } from '@shared/adjustments'
import { VideoPool } from './videoPool'
import { AdjustFilter, cssFilterFor } from './adjustFilter'
import { clipAt, sourceTimeAt } from './timeline'
import { evaluateKeyframes } from './keyframes'

export interface PreviewEngineOptions {
  /** Called on every rendered frame with the current timeline time. */
  onTick?: (time: number) => void
  /** Called when playback reaches the end of the timeline. */
  onEnded?: () => void
}

/** What the pointer is holding on the preview. */
export type HandleKind = 'move' | 'scale' | 'rotate'

export interface PickResult {
  kind: HandleKind
  /** Which corner, 0 = top left, 1 = top right, 2 = bottom right, 3 = bottom left. */
  corner: number
}

/**
 * The shape of the selected clip, in the coordinates of the project.
 *
 * The preview draws these handles over the picture and uses them to work
 * out what the pointer is holding.
 */
export interface OverlayGeometry {
  clipId: string
  /** The middle of the clip. */
  center: { x: number; y: number }
  /** The corners, clockwise from the top left. */
  corners: { x: number; y: number }[]
  /** The handle that turns the clip. */
  rotate: { x: number; y: number }
  /** The size of the clip, before it is turned. */
  width: number
  height: number
  /** Degrees. */
  rotation: number
  /** The multiplier the clip is scaled by. */
  scale: number
  /** The size of the source once it fits into the frame. */
  baseWidth: number
  baseHeight: number
  /** The offsets of the corners in the turned frame, -1..1. */
  local: { x: number; y: number }[]
}

/**
 * Draws the composition onto a canvas and drives playback.
 *
 * The clock is `performance.now()` rather than a media element's clock: the
 * timeline is the source of truth, and each video element is kept in sync
 * with it. That makes multi-track playback predictable — every clip follows
 * the same master clock instead of racing each other.
 */
export class PreviewEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private pool = new VideoPool()
  private adjustFilter = new AdjustFilter()
  private project: Project
  private audioCtx: AudioContext | null = null

  private time = 0
  private playing = false
  private rafId = 0
  private wallStart = 0
  private timeStart = 0
  private lastDrawn = -1
  private options: PreviewEngineOptions

  /** Backing-store scale; 1 means the canvas matches the project resolution. */
  private renderScale = 1

  /** The clip whose handles are drawn over the picture. */
  private selectionId: string | null = null

  constructor(canvas: HTMLCanvasElement, project: Project, options: PreviewEngineOptions = {}) {
    this.canvas = canvas
    this.project = project
    this.options = options
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('无法创建 2D 绘图上下文')
    this.ctx = ctx
    // A newly loaded frame has to trigger a repaint even while paused.
    this.pool.onMediaReady = () => {
      this.lastDrawn = -1
    }
    // The audio graph is created up front so that every media element is
    // routed through it from the start; it stays suspended until the user
    // actually plays something.
    this.createAudioContext()
    this.resize()
    this.rafId = requestAnimationFrame(this.loop)
  }

  private createAudioContext(): void {
    if (this.audioCtx) return
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    try {
      this.audioCtx = new Ctor()
      this.pool.setAudioContext(this.audioCtx)
    } catch {
      this.audioCtx = null
    }
  }

  setProject(project: Project): void {
    this.project = project
    this.resize()
    // A document edit (a transform tweak, a moved clip) has to show up in
    // the preview right away. While paused the render loop skips frames
    // that would not change anything, so the repaint is forced here.
    this.lastDrawn = -1
    this.render(this.time, true)
  }

  /** Marks the clip whose handles are drawn over the picture. */
  setSelection(clipId: string | null): void {
    if (this.selectionId === clipId) return
    this.selectionId = clipId
    this.lastDrawn = -1
    this.render(this.time, true)
  }

  /** Turns a point on the screen into a point in the project. */
  toProject(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    const { width: W, height: H } = this.project.settings
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
    return {
      x: ((clientX - rect.left) / rect.width) * W,
      y: ((clientY - rect.top) / rect.height) * H
    }
  }

  /**
   * The shape of the selected clip, if it is on screen.
   *
   * The handles only make sense while the clip is being shown, so nothing
   * is returned when the playhead is somewhere else.
   */
  overlay(): OverlayGeometry | null {
    if (!this.selectionId) return null
    // The lookup runs on every frame, so it walks the tracks instead of
    // building an array of every clip.
    let clip: Clip | null = null
    let track: Track | null = null
    for (const t of this.project.tracks) {
      for (const c of t.clips) {
        if (c.id === this.selectionId) {
          clip = c
          track = t
          break
        }
      }
      if (clip) break
    }
    if (!clip || !track) return null
    if (this.time < clip.start || this.time >= clip.start + clip.duration) return null
    if (track.kind !== 'video' || track.hidden) return null
    const asset = this.project.assets[clip.assetId]
    if (!asset || asset.kind === 'audio') return null

    const { width: W, height: H } = this.project.settings
    const offset = this.time - clip.start
    const scale = evaluateKeyframes(clip.keyframes.scale, offset, clip.transform.scale)
    const x = evaluateKeyframes(clip.keyframes.x, offset, clip.transform.x)
    const y = evaluateKeyframes(clip.keyframes.y, offset, clip.transform.y)
    const rotation = clip.transform.rotation

    const srcW = asset.width || W
    const srcH = asset.height || H
    const fit = Math.min(W / srcW, H / srcH)
    const baseWidth = srcW * fit
    const baseHeight = srcH * fit

    const center = { x: W / 2 + x * (W / 2), y: H / 2 + y * (H / 2) }
    const width = baseWidth * scale
    const height = baseHeight * scale
    const rad = (rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    // The corners in the frame of the clip, then turned with it.
    const local: { x: number; y: number }[] = [
      { x: -1, y: -1 },
      { x: 1, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 }
    ]
    const corners = local.map((c) => {
      const lx = (c.x * width) / 2
      const ly = (c.y * height) / 2
      return { x: center.x + lx * cos - ly * sin, y: center.y + lx * sin + ly * cos }
    })

    // The handle that turns the clip sits above the middle of the top edge.
    const gap = this.handleSize() * 3
    const ly = -(height / 2 + gap)
    const rotate = { x: center.x - ly * sin, y: center.y + ly * cos }

    return { clipId: clip.id, center, corners, rotate, width, height, rotation, scale, baseWidth, baseHeight, local }
  }

  /**
   * What the pointer is holding on the picture.
   *
   * The handles are a fixed size on screen, so the reach depends on how
   * far the picture is scaled down.
   */
  pick(x: number, y: number): PickResult | null {
    const o = this.overlay()
    if (!o) return null
    const reach = this.handleSize()

    if (Math.hypot(x - o.rotate.x, y - o.rotate.y) <= reach) {
      return { kind: 'rotate', corner: -1 }
    }
    for (let i = 0; i < o.corners.length; i++) {
      const c = o.corners[i]
      if (Math.hypot(x - c.x, y - c.y) <= reach) return { kind: 'scale', corner: i }
    }
    if (this.insideClip(o, x, y)) return { kind: 'move', corner: -1 }
    return null
  }

  /** Whether a point lies inside the turned clip. */
  private insideClip(o: OverlayGeometry, x: number, y: number): boolean {
    const rad = (-o.rotation * Math.PI) / 180
    const dx = x - o.center.x
    const dy = y - o.center.y
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    return Math.abs(lx) <= o.width / 2 && Math.abs(ly) <= o.height / 2
  }

  /** One screen pixel, in the coordinates of the project. */
  private handleSize(): number {
    return 9 / this.renderScale
  }

  setOptions(options: PreviewEngineOptions): void {
    this.options = options
  }

  /** Matches the backing store to the project resolution, capped for speed. */
  resize(): void {
    const { width, height } = this.project.settings
    const maxPixels = 1920 * 1080
    const projectPixels = width * height
    const scale = projectPixels > maxPixels ? Math.sqrt(maxPixels / projectPixels) : 1
    this.renderScale = scale

    const w = Math.max(2, Math.round(width * scale))
    const h = Math.max(2, Math.round(height * scale))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  get currentTime(): number {
    return this.time
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** Resumes the audio context. Must follow a user gesture. */
  ensureAudio(): void {
    this.createAudioContext()
    if (this.audioCtx?.state === 'suspended') void this.audioCtx.resume()
  }

  seek(time: number, options: { force?: boolean } = {}): void {
    const duration = this.timelineDuration()
    this.time = Math.max(0, Math.min(duration, time))
    if (this.playing) {
      this.timeStart = this.time
      this.wallStart = performance.now()
    }
    this.syncMedia(this.time, options.force ?? true)
    this.render(this.time, true)
  }

  play(): void {
    if (this.playing) return
    this.ensureAudio()
    const duration = this.timelineDuration()
    if (this.time >= duration - 1e-3) this.time = 0
    this.playing = true
    this.timeStart = this.time
    this.wallStart = performance.now()
    this.lastDrawn = -1
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.pool.pauseAll()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  dispose(): void {
    this.playing = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.pool.dispose()
    this.adjustFilter.dispose()
    if (this.audioCtx) {
      void this.audioCtx.close()
      this.audioCtx = null
    }
  }

  private timelineDuration(): number {
    let end = 0
    for (const track of this.project.tracks) {
      for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
    }
    return end
  }

  private loop = (): void => {
    if (this.playing) {
      const elapsed = (performance.now() - this.wallStart) / 1000
      const duration = this.timelineDuration()
      let t = this.timeStart + elapsed

      if (t >= duration) {
        t = duration
        this.time = t
        this.syncMedia(t, true)
        this.render(t, true)
        this.playing = false
        this.options.onEnded?.()
        this.options.onTick?.(t)
      } else {
        this.time = t
        this.syncMedia(t, false)
        this.render(t, false)
        this.options.onTick?.(t)
      }
    } else {
      // Paused: keep the media in sync and repaint whenever a frame
      // becomes available, so the canvas is never left blank.
      this.syncMedia(this.time, false)
      this.render(this.time, false)
    }
    this.rafId = requestAnimationFrame(this.loop)
  }

  /** Brings every media element in line with the master clock. */
  private syncMedia(t: number, force: boolean): void {
    const active = new Set<string>()

    for (const track of this.project.tracks) {
      const clip = clipAt(track, t)
      if (!clip) continue
      const asset = this.project.assets[clip.assetId]
      if (!asset) continue

      active.add(clip.id)
      const el = this.pool.acquire(clip.id, asset)
      const target = sourceTimeAt(clip, t)

      // The element plays at the rate the clip asks for, so a sped-up clip
      // runs through its source as fast as the timeline expects.
      const rate = rateAtOffset(clip, t - clip.start)
      if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate

      if (el.readyState >= 1) {
        const drift = el.currentTime - target
        const tolerance = this.playing ? 0.22 : 0.015
        if (force || Math.abs(drift) > tolerance) {
          try {
            el.currentTime = Math.max(0, target)
          } catch {
            /* seeking before metadata is ready */
          }
        }
      }

      const muted = track.muted || clip.muted
      const volume = muted
        ? 0
        : evaluateKeyframes(clip.keyframes.volume, t - clip.start, clip.volume)
      this.pool.setVolume(el, volume)

      if (this.playing) {
        if (el.paused) void el.play().catch(() => undefined)
      } else if (!el.paused) {
        el.pause()
      }
    }

    this.pool.retainOnly(active)
  }

  /** Composites the frame at timeline time `t`. */
  render(t: number, force: boolean): void {
    if (!force && Math.abs(t - this.lastDrawn) < 1e-4) return
    this.lastDrawn = t

    const { width: W, height: H, background } = this.project.settings
    const ctx = this.ctx

    ctx.save()
    ctx.setTransform(this.renderScale, 0, 0, this.renderScale, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = background
    ctx.fillRect(0, 0, W, H)

    // Tracks are stored top-to-bottom; draw from the bottom up so the top
    // track lands on top of the composition.
    for (let i = this.project.tracks.length - 1; i >= 0; i--) {
      const track = this.project.tracks[i]
      if (track.kind !== 'video' || track.hidden) continue
      const clip = clipAt(track, t)
      if (!clip) continue
      const asset = this.project.assets[clip.assetId]
      if (!asset || asset.kind === 'audio') continue
      const el = this.pool.acquire(clip.id, asset)
      if (el.readyState < 2 || el.videoWidth === 0) continue
      this.drawClip(ctx, clip, asset, el, t)
    }

    ctx.restore()

    // The handles of the selected clip go on top of everything.
    const overlay = this.overlay()
    if (overlay) this.drawOverlay(ctx, overlay)
  }

  /**
   * Draws the frame and the handles of the selected clip.
   *
   * The handles are a fixed size on the screen, so their size in project
   * coordinates depends on how far the picture is scaled down.
   */
  private drawOverlay(ctx: CanvasRenderingContext2D, o: OverlayGeometry): void {
    const u = 1 / this.renderScale
    const gap = this.handleSize() * 3

    ctx.save()
    ctx.translate(o.center.x, o.center.y)
    ctx.rotate((o.rotation * Math.PI) / 180)

    // The frame of the clip.
    ctx.strokeStyle = 'rgba(242, 160, 61, 0.85)'
    ctx.lineWidth = 1.4 * u
    ctx.setLineDash([7 * u, 5 * u])
    ctx.strokeRect(-o.width / 2, -o.height / 2, o.width, o.height)
    ctx.setLineDash([])

    // The corners, to stretch the clip with.
    const size = 4.5 * u
    ctx.fillStyle = 'rgba(242, 160, 61, 0.95)'
    for (const c of o.local) {
      const cx = (c.x * o.width) / 2
      const cy = (c.y * o.height) / 2
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size)
    }

    // The handle that turns the clip.
    const hy = -(o.height / 2 + gap)
    ctx.strokeStyle = 'rgba(242, 160, 61, 0.85)'
    ctx.lineWidth = 1.4 * u
    ctx.beginPath()
    ctx.moveTo(0, -o.height / 2)
    ctx.lineTo(0, hy)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(0, hy, size * 0.85, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(242, 160, 61, 0.95)'
    ctx.fill()

    ctx.restore()
  }

  private drawClip(
    ctx: CanvasRenderingContext2D,
    clip: Clip,
    asset: Asset,
    el: HTMLVideoElement,
    t: number
  ): void {
    const { width: W, height: H } = this.project.settings
    const local = t - clip.start

    const scale = evaluateKeyframes(clip.keyframes.scale, local, clip.transform.scale)
    const x = evaluateKeyframes(clip.keyframes.x, local, clip.transform.x)
    const y = evaluateKeyframes(clip.keyframes.y, local, clip.transform.y)
    const opacity = evaluateKeyframes(clip.keyframes.opacity, local, clip.opacity)
    const rotation = clip.transform.rotation

    // Match the export exactly: fit the source into the frame, then apply
    // the clip's scale multiplier.
    const srcW = asset.width || el.videoWidth
    const srcH = asset.height || el.videoHeight
    const fit = Math.min(W / srcW, H / srcH)
    const dw = srcW * fit * scale
    const dh = srcH * fit * scale

    const cx = W / 2 + x * (W / 2)
    const cy = H / 2 + y * (H / 2)

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
    ctx.translate(cx, cy)
    if (rotation) ctx.rotate((rotation * Math.PI) / 180)

    const adjustments = clip.adjustments
    if (adjustments && !isNeutral(adjustments)) {
      const size = this.filterSize(srcW * fit, srcH * fit)
      const filtered = this.adjustFilter.apply(el, adjustments, size.width, size.height)
      if (filtered) {
        ctx.drawImage(filtered, -dw / 2, -dh / 2, dw, dh)
        ctx.restore()
        return
      }
      // No GPU filter in this environment: the 2D canvas still knows a few
      // of the adjustments.
      ctx.filter = cssFilterFor(adjustments)
      ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh)
      ctx.filter = 'none'
      ctx.restore()
      return
    }

    ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()
  }

  /**
   * The size the filter works at.
   *
   * The picture is never filtered larger than the preview canvas itself — a
   * 4K composition would otherwise cost four times as much as it is worth
   * while the viewer only ever sees the scaled down result. Both sides are
   * scaled by the same factor so the picture keeps its shape.
   */
  private filterSize(width: number, height: number): { width: number; height: number } {
    const k = Math.min(
      1,
      this.canvas.width / Math.max(1, width),
      this.canvas.height / Math.max(1, height)
    )
    return {
      width: Math.max(1, Math.round(width * k)),
      height: Math.max(1, Math.round(height * k))
    }
  }

  /** Nudges the pool by priming the assets that appear on the timeline. */
  primeAssets(): void {
    for (const asset of Object.values(this.project.assets)) {
      this.pool.prime(asset)
    }
  }
}
