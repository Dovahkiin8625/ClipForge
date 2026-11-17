import type { Asset, SpriteSheet } from '@shared/types'
import { api } from '@/bridge'

/**
 * A shared cache for the derived media the timeline and the library both
 * need: thumbnail sprites, poster pictures and audio peak envelopes.
 *
 * All of them are expensive to produce (FFmpeg has to decode the file) and
 * cheap to reuse, so they live outside the project document and survive edits.
 */

const sprites = new Map<string, SpriteSheet>()
const posters = new Map<string, string>()
const waveforms = new Map<string, Float32Array>()
const images = new Map<string, HTMLImageElement>()

/** What is already on its way, so it is not asked for twice. */
const pendingSprites = new Set<string>()
const pendingPosters = new Set<string>()
const pendingWaveforms = new Set<string>()

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

  /** The single picture of a recording, shown while the sheet is baking. */
  poster(assetId: string): string | undefined {
    return posters.get(assetId)
  },

  waveform(assetId: string): Float32Array | undefined {
    return waveforms.get(assetId)
  },

  image(url: string): HTMLImageElement | undefined {
    return images.get(url)
  },

  /** Kicks off thumbnail and waveform generation for an asset, once. */
  ensure(asset: Asset): void {
    if (asset.kind !== 'audio') {
      // The card in the library shows a single picture of the recording, and
      // it should be there as soon as the file has been imported — long
      // before the whole filmstrip is baked. A picture is shown straight
      // from its file, so it needs none of this.
      if (
        asset.kind !== 'image' &&
        !posters.has(asset.id) &&
        !pendingPosters.has(asset.id)
      ) {
        pendingPosters.add(asset.id)
        void api.media
          .poster(asset.path, posterTime(asset), 320)
          .then((poster) => {
            if (!poster) return
            posters.set(asset.id, poster.url)
            notify()
          })
          .catch(() => undefined)
          .finally(() => pendingPosters.delete(asset.id))
      }

      if (!sprites.has(asset.id) && !pendingSprites.has(asset.id)) {
        pendingSprites.add(asset.id)
        const columns = asset.duration > 0 ? 10 : 1
        void api.media
          .sprite(
            asset.path,
            0,
            Math.max(asset.duration, 0.2),
            columns,
            160,
            asset.kind === 'image',
            asset.width,
            asset.height
          )
          .then((sheet) => {
            sprites.set(asset.id, sheet)
            const img = new Image()
            img.onload = () => notify()
            img.src = sheet.url
            images.set(sheet.url, img)
            notify()
          })
          .catch(() => undefined)
          .finally(() => pendingSprites.delete(asset.id))
      }
    }

    if (
      !waveforms.has(asset.id) &&
      asset.hasAudio &&
      asset.kind !== 'image' &&
      !pendingWaveforms.has(asset.id)
    ) {
      pendingWaveforms.add(asset.id)
      void api.media
        .waveform(asset.path, asset.duration)
        .then(({ peaks }) => {
          waveforms.set(asset.id, new Float32Array(peaks))
          notify()
        })
        .catch(() => undefined)
        .finally(() => pendingWaveforms.delete(asset.id))
    }
  }
}

/**
 * The moment of the recording that shows up on the card.
 *
 * A little way in — past the black frames at the head of a recording, and
 * close enough to the start to be found at once.
 */
function posterTime(asset: Asset): number {
  return Math.max(0.1, Math.min(2, asset.duration * 0.1))
}

/** Exposed for debugging and for the automated smoke test. */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __clipforgeMedia?: typeof mediaCache }).__clipforgeMedia = mediaCache
}
