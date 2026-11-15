import type { Asset, SpriteSheet } from '@shared/types'
import { api } from '@/bridge'

/**
 * A shared cache for the derived media the timeline and the library both
 * need: thumbnail sprites and audio peak envelopes.
 *
 * Both are expensive to produce (FFmpeg has to decode the file) and cheap to
 * reuse, so they live outside the project document and survive edits.
 */

const sprites = new Map<string, SpriteSheet>()
const waveforms = new Map<string, Float32Array>()
const images = new Map<string, HTMLImageElement>()
const pending = new Set<string>()
const listeners = new Set<() => void>()

let version = 0

function notify(): void {
  version++
  for (const listener of listeners) listener()
}

export const mediaCache = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  getVersion(): number {
    return version
  },

  sprite(assetId: string): SpriteSheet | undefined {
    return sprites.get(assetId)
  },

  waveform(assetId: string): Float32Array | undefined {
    return waveforms.get(assetId)
  },

  image(url: string): HTMLImageElement | undefined {
    return images.get(url)
  },

  /** Kicks off thumbnail and waveform generation for an asset, once. */
  ensure(asset: Asset): void {
    if (pending.has(asset.id)) return

    if (!sprites.has(asset.id) && asset.kind !== 'audio') {
      pending.add(asset.id)
      const columns = asset.duration > 0 ? 10 : 1
      void api.media
        .sprite(asset.path, 0, Math.max(asset.duration, 0.2), columns, 160, asset.kind === 'image')
        .then((sheet) => {
          sprites.set(asset.id, sheet)
          const img = new Image()
          img.onload = () => notify()
          img.src = sheet.url
          images.set(sheet.url, img)
          pending.delete(asset.id)
          notify()
        })
        .catch(() => {
          pending.delete(asset.id)
        })
    }

    if (!waveforms.has(asset.id) && asset.hasAudio && asset.kind !== 'image') {
      pending.add(asset.id)
      void api.media
        .waveform(asset.path, asset.duration)
        .then(({ peaks }) => {
          waveforms.set(asset.id, new Float32Array(peaks))
          pending.delete(asset.id)
          notify()
        })
        .catch(() => {
          pending.delete(asset.id)
        })
    }
  }
}

/** Exposed for debugging and for the automated smoke test. */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __clipforgeMedia?: typeof mediaCache }).__clipforgeMedia = mediaCache
}
