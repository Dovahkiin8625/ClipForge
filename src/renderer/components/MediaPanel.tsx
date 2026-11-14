import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Asset } from '@shared/types'
import { useEditor } from '@/state/store'
import { mediaCache } from '@/state/mediaCache'
import { api } from '@/bridge'
import { formatDuration } from '@/engine/timelineDraw'

export function MediaPanel(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const mediaVersion = useSyncExternalStore(
    mediaCache.subscribe,
    mediaCache.getVersion,
    mediaCache.getVersion
  )

  const assets = useMemo(
    () => Object.values(project.assets),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project.assets, mediaVersion]
  )

  useEffect(() => {
    for (const asset of assets) mediaCache.ensure(asset)
  }, [assets])

  const importFiles = useCallback(async () => {
    const imported = await api.media.importFiles()
    if (imported.length === 0) return
    const store = useEditor.getState()
    store.pushHistory()
    store.addAssets(imported)
    store.toast(`已导入 ${imported.length} 个文件`)
  }, [])

  const insertAtPlayhead = useCallback((asset: Asset) => {
    const store = useEditor.getState()
    const track =
      store.project.tracks.find((t) => t.kind === 'video') ??
      store.project.tracks[0]
    // History is recorded before anything changes, so a single undo takes the
    // whole insert — including a track created for it — back.
    store.pushHistory()
    if (!track) {
      // No tracks at all — make one for the asset instead of ignoring it.
      const kind = asset.kind === 'audio' ? 'audio' : 'video'
      const trackId = store.ensureTrack(kind)
      if (!trackId) return
      store.insertClip(asset.id, trackId, store.playhead)
      return
    }
    store.insertClip(asset.id, track.id, store.playhead)
  }, [])

  const removeAsset = useCallback((assetId: string) => {
    const store = useEditor.getState()
    store.mutate((draft) => {
      delete draft.assets[assetId]
      for (const track of draft.tracks) {
        track.clips = track.clips.filter((c) => c.assetId !== assetId)
      }
    })
  }, [])

  return (
    <aside className="media-panel">
      <div className="media-panel__head">
        <span className="panel-title">媒体库</span>
        <button className="btn btn--sm" onClick={() => void importFiles()}>
          导入
        </button>
      </div>

      <div className="media-panel__body">
        {assets.length === 0 ? (
          <div className="empty">
            <LeaderMark />
            <p className="empty__title">还没有素材</p>
            <p className="empty__body">导入视频或音频开始剪辑</p>
            <button className="btn btn--primary btn--sm" onClick={() => void importFiles()}>
              导入媒体
            </button>
          </div>
        ) : (
          <div className="media-grid">
            {assets.map((asset) => (
              <div
                key={asset.id}
                className="asset-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-clipforge-asset', asset.id)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
                onDoubleClick={() => insertAtPlayhead(asset)}
                title={`${asset.name}\n双击添加到播放头位置`}
              >
                <AssetThumb asset={asset} />
                <div className="asset-card__meta">
                  <span className="asset-card__name">{asset.name}</span>
                  <span className="asset-card__time mono">
                    {asset.kind === 'image' ? '图片' : formatDuration(asset.duration)}
                  </span>
                </div>
                <button
                  className="asset-card__remove"
                  title="从项目中移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeAsset(asset.id)
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {assets.length > 0 ? (
        <div className="media-panel__foot">
          <span className="label">{assets.length} 个素材</span>
          <span className="label">双击添加到播放头</span>
        </div>
      ) : null}
    </aside>
  )
}

function AssetThumb({ asset }: { asset: Asset }): React.JSX.Element {
  const sprite = mediaCache.sprite(asset.id)

  if (asset.kind === 'audio' || !sprite) {
    return (
      <div className="asset-card__thumb asset-card__thumb--empty">
        {asset.kind === 'audio' ? <AudioGlyph /> : <FilmGlyph />}
      </div>
    )
  }

  // The sprite is a grid of frames; scaling the background by the grid size
  // and pinning it to the top-left shows exactly the first frame.
  return (
    <div
      className="asset-card__thumb"
      style={{
        backgroundImage: `url("${sprite.url}")`,
        backgroundSize: `${sprite.cols * 100}% ${sprite.rows * 100}%`,
        backgroundPosition: '0 0',
        aspectRatio: `${sprite.frameWidth} / ${sprite.frameHeight}`
      }}
    />
  )
}

/** The academy leader mark — the classic countdown frame. */
function LeaderMark(): React.JSX.Element {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <circle cx="36" cy="36" r="34" stroke="#242c38" strokeWidth="1" />
      <circle cx="36" cy="36" r="24" stroke="#2d3745" strokeWidth="1" />
      <path d="M36 2v68M2 36h68" stroke="#1c232e" strokeWidth="1" />
      <path d="M12 12l48 48M60 12L12 60" stroke="#161c25" strokeWidth="1" />
      <circle cx="36" cy="36" r="7" stroke="#f2a03d" strokeWidth="1.4" opacity="0.85" />
    </svg>
  )
}

function AudioGlyph(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <path
        d="M3 13h2.5M8 8.5v9M11 5.5v15M14 9.5v7M17 7v11M20 11.5v3M23 13h.5"
        stroke="#9b87f5"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.8"
      />
    </svg>
  )
}

function FilmGlyph(): React.JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <rect x="3.5" y="6.5" width="19" height="13" rx="1.5" stroke="#3a4655" />
      <path d="M8 6.5v13M18 6.5v13" stroke="#3a4655" />
    </svg>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
