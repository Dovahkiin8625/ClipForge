import type { Asset } from '@shared/types'
import { toUrl } from './videoPool'

/**
 * A pool of `<img>` elements for the still assets.
 *
 * A picture cannot be decoded by a `<video>` element, so stills need their
 * own. One element is kept per asset: the same picture can sit on several
 * clips at once and the browser decodes it only once.
 */
export class ImagePool {
  private images = new Map<string, HTMLImageElement>()

  /** Called whenever a picture has been decoded and can be drawn. */
  onImageReady: (() => void) | null = null

  /** The element for an asset, created and loaded on first use. */
  acquire(asset: Asset): HTMLImageElement {
    const existing = this.images.get(asset.id)
    if (existing) return existing

    const img = document.createElement('img')
    img.decoding = 'async'
    // The picture is served over the `clipforge://` scheme, which is a
    // different origin than the app. Asking for it anonymously (the
    // protocol answers with `Access-Control-Allow-Origin: *`) keeps the
    // canvas clean, so the pixels can be read back.
    img.crossOrigin = 'anonymous'
    img.src = asset.url ?? (asset.path ? toUrl(asset.path) : '')
    const notify = (): void => this.onImageReady?.()
    img.addEventListener('load', notify)
    img.addEventListener('error', notify)
    this.images.set(asset.id, img)
    return img
  }

  /** Whether the picture is decoded and ready to be drawn. */
  isReady(img: HTMLImageElement): boolean {
    return img.complete && img.naturalWidth > 0
  }

  /** Starts loading a picture so it is there when the clip is reached. */
  prime(asset: Asset): void {
    this.acquire(asset)
  }

  /** Throws away the pictures of assets that are no longer in the project. */
  retainAssets(assetIds: Set<string>): void {
    for (const [assetId, img] of [...this.images.entries()]) {
      if (assetIds.has(assetId)) continue
      img.removeAttribute('src')
      this.images.delete(assetId)
    }
  }

  dispose(): void {
    for (const img of this.images.values()) img.removeAttribute('src')
    this.images.clear()
  }
}
