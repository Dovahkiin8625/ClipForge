import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Asset } from '@shared/types'
import { mediaCache } from '@/state/mediaCache'
import { formatDuration } from '@/engine/timelineDraw'
import { toUrl } from '@/engine/videoPool'

/**
 * A popup that shows one asset on its own: the picture plays, the sound plays,
 * and the metadata of the file sits underneath.
 *
 * The library used to insert the asset on a double click; now the double click
 * opens this window and the "+" button on the card does the inserting.
 */
export function AssetPreviewDialog({
  asset,
  onClose
}: {
  asset: Asset
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The URL is resolved when the asset is imported; an asset that comes from
  // a saved project may have lost it, so the path is used instead.
  const url = asset.url || (asset.path ? toUrl(asset.path) : '')

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${asset.name}`}
      onPointerDown={(e) => {
        // Only a click on the backdrop itself closes the window; a click
        // inside the dialog must not close it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="dialog dialog--preview">
        <header className="dialog__head">
          <span className="dialog__title" title={asset.name}>
            {asset.name}
          </span>
          <button className="btn btn--ghost btn--icon" onClick={onClose} title="关闭 (Esc)">
            <CloseIcon />
          </button>
        </header>

        <div className="dialog__body preview-dialog__body">
          {asset.kind === 'image' ? (
            <div className="preview-dialog__image">
              <img src={url} alt={asset.name} />
            </div>
          ) : asset.kind === 'audio' ? (
            <div className="preview-dialog__audio">
              <Waveform assetId={asset.id} />
              <audio
                className="preview-dialog__player"
                src={url}
                controls
                autoPlay
                preload="auto"
              />
            </div>
          ) : (
            <video
              className="preview-dialog__video"
              src={url}
              controls
              autoPlay
              playsInline
              preload="auto"
              crossOrigin="anonymous"
            />
          )}
        </div>

        <footer className="dialog__foot preview-dialog__foot">
          <span className="label">{KIND_LABEL[asset.kind]}</span>
          <span className="label mono">
            {asset.width > 0 && asset.height > 0 ? `${asset.width}×${asset.height}` : '—'}
          </span>
          <span className="label mono">
            {asset.kind === 'image' ? '静止' : formatDuration(asset.duration)}
          </span>
          {asset.codec ? <span className="label mono">{asset.codec}</span> : null}
        </footer>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<Asset['kind'], string> = {
  video: '视频',
  audio: '音频',
  image: '图片'
}

/**
 * The sound of the asset, drawn as a bar chart.
 *
 * The peaks come from the shared media cache, so they are the same ones the
 * timeline draws; they may not be there yet when the window opens.
 */
function Waveform({ assetId }: { assetId: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The peaks are produced in the background; the drawing follows them.
  useSyncExternalStore(
    mediaCache.subscribe,
    mediaCache.getVersion,
    mediaCache.getVersion
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const peaks = mediaCache.waveform(assetId)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    canvas.width = width * window.devicePixelRatio
    canvas.height = height * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    ctx.clearRect(0, 0, width, height)

    if (!peaks || peaks.length === 0) return
    // Fold the peaks down into one bar per two pixels.
    const buckets = Math.max(1, Math.floor(width / 2))
    const per = peaks.length / buckets
    const gap = 1
    ctx.fillStyle = '#9b87f5'
    for (let i = 0; i < buckets; i++) {
      const from = Math.floor(i * per)
      const to = Math.min(peaks.length, Math.floor((i + 1) * per))
      let peak = 0
      for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j])
      const h = Math.max(1, peak * (height - 2))
      ctx.fillRect(i * 2, (height - h) / 2, 2 - gap, h)
    }
  })

  return <canvas className="preview-dialog__wave" ref={canvasRef} />
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
