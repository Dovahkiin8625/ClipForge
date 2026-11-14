import { useEffect, useMemo, useState } from 'react'
import { useEditor } from '@/state/store'
import { api } from '@/bridge'
import { projectDuration } from '@/engine/timeline'
import type { AudioFormat, ExportKind, ExportPreset, GifDither } from '@shared/types'

const KIND_INFO: { key: ExportKind; label: string; detail: string }[] = [
  { key: 'video', label: '视频', detail: 'MP4 · H.264' },
  { key: 'audio', label: '音频', detail: '混音 · 无画面' },
  { key: 'gif', label: 'GIF', detail: '动图 · 体积小' }
]

const PRESET_INFO: { key: ExportPreset; label: string; detail: string }[] = [
  { key: 'web', label: '网络', detail: '1080p · H.264 · 快速' },
  { key: 'high', label: '高质量', detail: '原始分辨率 · H.264' },
  { key: 'master', label: '母版', detail: '原始分辨率 · 高码率' }
]

const AUDIO_INFO: { key: AudioFormat; label: string; detail: string }[] = [
  { key: 'mp3', label: 'MP3', detail: '通用 · 192 kbps' },
  { key: 'm4a', label: 'M4A', detail: 'AAC · 256 kbps' },
  { key: 'wav', label: 'WAV', detail: '无损 · 未压缩' },
  { key: 'flac', label: 'FLAC', detail: '无损 · 压缩' }
]

const GIF_WIDTHS = [320, 480, 720, 960]
const GIF_FPS = [10, 15, 20]
const DITHER_INFO: { key: GifDither; label: string }[] = [
  { key: 'none', label: '不用' },
  { key: 'bayer', label: '有序抖动' },
  { key: 'sierra2', label: 'Sierra' }
]

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const exportState = useEditor((s) => s.exportState)
  const [kind, setKind] = useState<ExportKind>('video')
  const [preset, setPreset] = useState<ExportPreset>('web')
  const [audioFormat, setAudioFormat] = useState<AudioFormat>('mp3')
  const [gifWidth, setGifWidth] = useState(480)
  const [gifFps, setGifFps] = useState(15)
  const [gifDither, setGifDither] = useState<GifDither>('bayer')
  const [gifLoop, setGifLoop] = useState(true)
  const [outPath, setOutPath] = useState('')
  const [showLog, setShowLog] = useState(false)

  const duration = projectDuration(project)
  const hasContent = project.tracks.some((t) => t.clips.length > 0)
  // The mix only carries sound when some clip still has sound to give.
  const hasAudio = project.tracks.some(
    (t) =>
      !t.muted &&
      t.clips.some((c) => {
        const asset = project.assets[c.assetId]
        return !!asset?.hasAudio && asset.kind !== 'image' && !c.muted
      })
  )
  const running = exportState.status === 'running' || exportState.status === 'preparing'

  // Mirrors the resolution the export pipeline will actually produce.
  const resolution = useMemo(() => {
    const src = project.settings
    if (kind === 'gif') {
      const w = Math.min(gifWidth, src.width)
      const h = Math.max(2, Math.round((src.height / src.width) * w))
      return `${w}×${h}`
    }
    if (kind === 'audio') return '仅声音'
    const cappedH = preset === 'web' && src.height > 1080 ? 1080 : src.height
    const w = Math.round((src.width / src.height) * cappedH)
    const evenW = w % 2 === 0 ? w : w - 1
    const evenH = cappedH % 2 === 0 ? cappedH : cappedH - 1
    return `${evenW}×${evenH}`
  }, [kind, preset, gifWidth, project.settings])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  const chooseOutput = async (): Promise<void> => {
    const path = await api.export.chooseOutput({
      defaultName: project.name || 'clipforge',
      kind,
      format: audioFormat
    })
    if (path) setOutPath(path)
  }

  const changeKind = (next: ExportKind): void => {
    if (next === kind) return
    setKind(next)
    // The file type follows the kind, so the old path is of no use.
    setOutPath('')
  }

  const start = async (): Promise<void> => {
    let path = outPath
    if (!path) {
      path =
        (await api.export.chooseOutput({
          defaultName: project.name || 'clipforge',
          kind,
          format: audioFormat
        })) ?? ''
      if (!path) return
      setOutPath(path)
    }
    try {
      await api.export.start(project, {
        path,
        kind,
        preset,
        audioFormat,
        gif: {
          width: gifWidth,
          fps: gifFps,
          // 0 lets the GIF run forever, -1 plays it exactly once.
          loop: gifLoop ? 0 : -1,
          dither: gifDither
        }
      })
    } catch (err) {
      useEditor.getState().toast(String(err), 'error')
    }
  }

  const status = exportState.status
  const done = status === 'done'
  const failed = status === 'error'
  const blocked = kind === 'audio' && !hasAudio

  const title =
    kind === 'audio' ? '导出音频' : kind === 'gif' ? '导出 GIF' : '导出视频'

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog">
        <header className="dialog__head">
          <h2 className="dialog__title">{title}</h2>
          <button
            className="btn btn--ghost btn--icon"
            onClick={onClose}
            disabled={running}
            aria-label="关闭"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="dialog__body">
          {running || done || failed ? (
            <div className="export-progress">
              <div className="export-progress__head">
                <span className="export-progress__label">{exportState.message}</span>
                <span className="mono export-progress__pct">
                  {(exportState.progress.progress * 100).toFixed(0)}%
                </span>
              </div>

              <div className="progress-track">
                <div
                  className={`progress-track__fill${failed ? ' is-error' : ''}`}
                  style={{ width: `${(exportState.progress.progress * 100).toFixed(1)}%` }}
                />
              </div>

              <div className="export-progress__stats">
                <Stat label="已导出" value={`${exportState.progress.outTime.toFixed(1)}s / ${duration.toFixed(1)}s`} />
                <Stat label="速度" value={exportState.progress.speed || '--'} />
                <Stat label="预计剩余" value={exportState.progress.eta || '--:--'} />
                <Stat label="大小" value={exportState.progress.totalSize || '--'} />
              </div>

              {done && exportState.outputPath ? (
                <div className="export-done">
                  <span className="export-done__path">{exportState.outputPath}</span>
                  <button
                    className="btn btn--sm"
                    onClick={() => void api.export.reveal(exportState.outputPath!)}
                  >
                    打开所在文件夹
                  </button>
                </div>
              ) : null}

              {exportState.log.length > 0 ? (
                <div className="export-log">
                  <button
                    className="export-log__toggle"
                    onClick={() => setShowLog((v) => !v)}
                  >
                    {showLog ? '隐藏日志' : '显示日志'} ({exportState.log.length})
                  </button>
                  {showLog ? (
                    <pre className="export-log__body mono">{exportState.log.join('\n')}</pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <section className="dialog__section">
                <span className="panel-title">类型</span>
                <div className="preset-grid">
                  {KIND_INFO.map((k) => (
                    <button
                      key={k.key}
                      className={`preset${kind === k.key ? ' is-active' : ''}`}
                      onClick={() => changeKind(k.key)}
                    >
                      <span className="preset__label">{k.label}</span>
                      <span className="preset__detail">{k.detail}</span>
                    </button>
                  ))}
                </div>
              </section>

              {kind === 'video' ? (
                <section className="dialog__section">
                  <span className="panel-title">画质</span>
                  <div className="preset-grid">
                    {PRESET_INFO.map((p) => (
                      <button
                        key={p.key}
                        className={`preset${preset === p.key ? ' is-active' : ''}`}
                        onClick={() => setPreset(p.key)}
                      >
                        <span className="preset__label">{p.label}</span>
                        <span className="preset__detail">{p.detail}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {kind === 'audio' ? (
                <section className="dialog__section">
                  <span className="panel-title">音频格式</span>
                  <div className="preset-grid preset-grid--4">
                    {AUDIO_INFO.map((a) => (
                      <button
                        key={a.key}
                        className={`preset${audioFormat === a.key ? ' is-active' : ''}`}
                        onClick={() => setAudioFormat(a.key)}
                      >
                        <span className="preset__label">{a.label}</span>
                        <span className="preset__detail">{a.detail}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {kind === 'gif' ? (
                <>
                  <section className="dialog__section">
                    <div className="dialog__row">
                      <span className="panel-title">宽度</span>
                      <span className="mono dialog__meta">像素</span>
                    </div>
                    <div className="preset-grid preset-grid--4">
                      {GIF_WIDTHS.map((w) => (
                        <button
                          key={w}
                          className={`preset${gifWidth === w ? ' is-active' : ''}`}
                          onClick={() => setGifWidth(w)}
                        >
                          <span className="preset__label">{w}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="dialog__section">
                    <div className="dialog__row">
                      <span className="panel-title">帧率</span>
                      <span className="mono dialog__meta">帧 / 秒</span>
                    </div>
                    <div className="preset-grid">
                      {GIF_FPS.map((f) => (
                        <button
                          key={f}
                          className={`preset${gifFps === f ? ' is-active' : ''}`}
                          onClick={() => setGifFps(f)}
                        >
                          <span className="preset__label">{f}</span>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="dialog__section">
                    <div className="dialog__row">
                      <span className="panel-title">抖动与循环</span>
                    </div>
                    <div className="preset-grid">
                      {DITHER_INFO.map((d) => (
                        <button
                          key={d.key}
                          className={`preset${gifDither === d.key ? ' is-active' : ''}`}
                          onClick={() => setGifDither(d.key)}
                        >
                          <span className="preset__label">{d.label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="preset-grid" style={{ marginTop: 8 }}>
                      <button
                        className={`preset${gifLoop ? ' is-active' : ''}`}
                        onClick={() => setGifLoop(true)}
                      >
                        <span className="preset__label">循环播放</span>
                      </button>
                      <button
                        className={`preset${!gifLoop ? ' is-active' : ''}`}
                        onClick={() => setGifLoop(false)}
                      >
                        <span className="preset__label">播放一次</span>
                      </button>
                    </div>
                  </section>
                </>
              ) : null}

              <section className="dialog__section">
                <div className="dialog__row">
                  <span className="panel-title">输出</span>
                  <span className="mono dialog__meta">
                    {resolution} ·{' '}
                    {kind === 'audio' ? '48kHz' : kind === 'gif' ? `${gifFps}fps` : `${project.settings.fps}fps`}{' '}
                    · {duration.toFixed(1)}s
                  </span>
                </div>
                <div className="path-field">
                  <span className="path-field__text" title={outPath}>
                    {outPath || '尚未选择保存位置'}
                  </span>
                  <button className="btn btn--sm" onClick={() => void chooseOutput()}>
                    选择…
                  </button>
                </div>
              </section>

              {!hasContent ? (
                <p className="dialog__warning">时间轴上还没有片段，无法导出。</p>
              ) : null}

              {blocked ? (
                <p className="dialog__warning">时间轴上没有任何声音，无法导出音频。</p>
              ) : null}

              {kind === 'gif' && duration > 30 ? (
                <p className="dialog__hint">
                  GIF 动图的体积随时长增长，{duration.toFixed(0)} 秒的素材导出后可能很大。
                </p>
              ) : null}
            </>
          )}
        </div>

        <footer className="dialog__foot">
          {running ? (
            <button className="btn" onClick={() => void api.export.cancel()}>
              取消导出
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              关闭
            </button>
          )}
          <button
            className="btn btn--primary"
            disabled={!hasContent || blocked || running || done}
            onClick={() => void start()}
          >
            {done ? '已导出' : '开始导出'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value mono">{value}</span>
    </div>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
