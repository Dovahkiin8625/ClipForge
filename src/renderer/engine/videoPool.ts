import type { Asset } from '@shared/types'

/**
 * A pool of `<video>` elements keyed by asset.
 *
 * The same asset can appear twice at once — on two tracks, at two different
 * source offsets — so elements are *leased* per clip rather than owned per
 * asset. When every element for an asset is already leased, a new one is
 * created; when a lease is released the element returns to the free pool.
 *
 * Audio is routed through Web Audio so that per-clip volume (and its
 * keyframes) can be applied independently.
 */
export class VideoPool {
  private audioCtx: AudioContext | null = null
  private elements = new Map<string, HTMLVideoElement[]>()
  private leases = new Map<string, { assetId: string; el: HTMLVideoElement }>()
  private sources = new WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>()
  private gains = new WeakMap<HTMLVideoElement, GainNode>()

  /** Called whenever an element becomes able to display a frame. */
  onMediaReady: (() => void) | null = null

  setAudioContext(ctx: AudioContext): void {
    this.audioCtx = ctx
  }

  private createElement(asset: Asset): HTMLVideoElement {
    const el = document.createElement('video')
    el.src = asset.url ?? (asset.path ? toUrl(asset.path) : '')
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    el.playsInline = true
    el.muted = false
    el.volume = 1
    // Keep it out of the layout — the canvas is what the user sees.
    el.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;'
    el.setAttribute('aria-hidden', 'true')
    document.body.appendChild(el)

    const notify = (): void => this.onMediaReady?.()
    el.addEventListener('loadeddata', notify)
    el.addEventListener('canplay', notify)
    el.addEventListener('loadedmetadata', notify)

    if (this.audioCtx) {
      try {
        const source = this.audioCtx.createMediaElementSource(el)
        const gain = this.audioCtx.createGain()
        gain.gain.value = 1
        source.connect(gain)
        gain.connect(this.audioCtx.destination)
        this.sources.set(el, source)
        this.gains.set(el, gain)
      } catch {
        // Routing can fail if the element was already connected; the video
        // still plays, just without independent volume control.
      }
    }
    return el
  }

  /** Leases an element for a clip. */
  acquire(clipId: string, asset: Asset): HTMLVideoElement {
    const existing = this.leases.get(clipId)
    if (existing) return existing.el

    let list = this.elements.get(asset.id)
    if (!list) {
      list = []
      this.elements.set(asset.id, list)
    }

    // Reuse an element that no other clip is holding.
    const claimed = new Set([...this.leases.values()].map((l) => l.el))
    let el = list.find((e) => !claimed.has(e))
    if (!el) {
      el = this.createElement(asset)
      list.push(el)
    }

    this.leases.set(clipId, { assetId: asset.id, el })
    return el
  }

  release(clipId: string): void {
    this.leases.delete(clipId)
  }

  /** Stops every element — used when playback pauses. */
  pauseAll(): void {
    for (const list of this.elements.values()) {
      for (const el of list) {
        if (!el.paused) el.pause()
      }
    }
  }

  /** Releases every lease whose clip is no longer present. */
  retainOnly(clipIds: Set<string>): void {
    for (const clipId of [...this.leases.keys()]) {
      if (!clipIds.has(clipId)) this.leases.delete(clipId)
    }
  }

  getGain(el: HTMLVideoElement): GainNode | null {
    return this.gains.get(el) ?? null
  }

  setVolume(el: HTMLVideoElement, value: number): void {
    const gain = this.gains.get(el)
    if (gain) {
      const t = this.audioCtx?.currentTime ?? 0
      gain.gain.setTargetAtTime(Math.max(0, value), t, 0.01)
    } else {
      el.volume = Math.max(0, Math.min(1, value))
    }
  }

  /** Loads metadata for an asset so the first frame is available quickly. */
  prime(asset: Asset): void {
    let list = this.elements.get(asset.id)
    if (!list) {
      list = []
      this.elements.set(asset.id, list)
    }
    if (list.length > 0) return
    const el = this.createElement(asset)
    el.load()
    list.push(el)
  }

  dispose(): void {
    for (const list of this.elements.values()) {
      for (const el of list) {
        el.pause()
        el.removeAttribute('src')
        el.load()
        el.remove()
      }
    }
    this.elements.clear()
    this.leases.clear()
  }
}

/**
 * The renderer cannot open `file://` URLs directly; media is served through
 * the `clipforge://` protocol registered in the main process.
 */
let schemeReady = false
function toUrl(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    if (!schemeReady) {
      schemeReady = true
    }
    return path
  }
  const normalised = path.replace(/\\/g, '/')
  return `clipforge://media/${encodeURI(normalised)}`
}
