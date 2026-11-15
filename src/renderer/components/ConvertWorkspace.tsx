import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConvertFormat, ConvertOptions, ConvertState, ProbeResult } from '@shared/types'
import { FORMATS, FORMAT_ORDER, isAudioOnly } from '@shared/convertFormats'
import { useEditor } from '@/state/store'
import { api } from '@/bridge'
import { formatDuration } from '@/engine/timelineDraw'

/** One entry of the conversion queue. */
interface ConvertTask {
  id: string
  input: string
  name: string
  state: ConvertState
}

const QUALITY: { id: NonNullable<ConvertOptions['quality']>; label: string }[] = [
  { id: 'high', label: '高质量' },
  { id: 'medium', label: '标准' },
  { id: 'low', label: '小体积' }
]

const RESOLUTIONS = [
  { id: 'source', label: '原始' },
  { id: '2160', label: '2160p' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
  { id: '480', label: '480p' },
  { id: 'custom', label: '自定义' }
]

const FRAMERATES = [
  { id: 'source', label: '原始' },
  { id: '24', label: '24' },
  { id: '25', label: '25' },
  { id: '30', label: '30' },
  { id: '60', label: '60' }
]

let taskSeq = 0

/**
 * The conversion workspace.
 *
 * Converting is a queue, not a dialog: several files can be lined up, each
 * one keeps its own progress, and the finished ones can be handed to the
 * editor. The three columns follow that order — the source, the settings it
 * is converted with, and what came out of it.
 */
export function ConvertWorkspace(): React.JSX.Element {
  const assets = useEditor((s) => s.project.assets)
  const toast = useEditor((s) => s.toast)

  const [input, setInput] = useState('')
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [format, setFormat] = useState<ConvertFormat>('mp4')
  const [videoCodec, setVideoCodec] = useState<string>(FORMATS.mp4.defaultVideoCodec ?? '')
  const [audioCodec, setAudioCodec] = useState<string>(FORMATS.mp4.defaultAudioCodec ?? '')
  const [resolution, setResolution] = useState('source')
  const [customWidth, setCustomWidth] = useState(1920)
  const [customHeight, setCustomHeight] = useState(1080)
  const [framerate, setFramerate] = useState('source')
  const [quality, setQuality] = useState<NonNullable<ConvertOptions['quality']>>('medium')
  const [audioBitrate, setAudioBitrate] = useState(192)
  const [outputDir, setOutputDir] = useState('')
  const [fileName, setFileName] = useState('')
  const [tasks, setTasks] = useState<ConvertTask[]>([])
  const runningId = useRef<string | null>(null)

  const spec = FORMATS[format]
  const audioOnly = isAudioOnly(format)

  /* ---------------------------------------------------------------- */
  /* Defaults                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!outputDir) {
      void api.app.downloadsPath().then((p) => setOutputDir(p)).catch(() => undefined)
    }
  }, [outputDir])

  // Every container has its own encoders, so a new format brings its own
  // defaults with it.
  const pickFormat = (next: ConvertFormat): void => {
    const s = FORMATS[next]
    setFormat(next)
    if (!s) return
    setVideoCodec(s.defaultVideoCodec ?? s.videoCodecs[0]?.id ?? '')
    setAudioCodec(s.defaultAudioCodec ?? s.audioCodecs[0]?.id ?? '')
  }

  const chooseSource = useCallback(async (): Promise<void> => {
    const picked = await api.convert.chooseInput()
    if (!picked) return
    setInput(picked)
    setFileName(stemOf(picked))
    try {
      setProbe(await api.media.probe(picked))
    } catch {
      setProbe(null)
    }
  }, [])

  const useAsset = (path: string): void => {
    setInput(path)
    setFileName(stemOf(path))
    void api.media
      .probe(path)
      .then(setProbe)
      .catch(() => setProbe(null))
  }

  /* ---------------------------------------------------------------- */
  /* The queue                                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const offState = api.convert.onState((s) => {
      const id = runningId.current
      if (!id) return
      setTasks((list) =>
        list.map((t) => (t.id === id ? { ...t, state: s } : t))
      )
      if (s.status === 'done' || s.status === 'error' || s.status === 'cancelled') {
        runningId.current = null
      }
    })
    return offState
  }, [])

  const targetSize = useMemo((): { width: number; height: number } => {
    if (!probe) return { width: 0, height: 0 }
    const srcRatio = probe.width && probe.height ? probe.width / probe.height : 16 / 9
    if (resolution === 'source') return { width: 0, height: 0 }
    if (resolution === 'custom') return { width: customWidth, height: customHeight }
    const height = Number(resolution)
    return { width: Math.round(srcRatio * height), height }
  }, [probe, resolution, customWidth, customHeight])

  const start = async (): Promise<void> => {
    if (!input) {
      toast('请先选择源文件', 'error')
      return
    }
    if (!outputDir) {
      toast('请先选择输出目录', 'error')
      return
    }

    const base = input.split(/[\\/]/).pop() ?? 'output'
    const stem = fileName.trim() || stemOf(input)

    const options: ConvertOptions = {
      input,
      outputDir,
      fileName: stem,
      format
    }
    if (!audioOnly) {
      options.videoCodec = videoCodec
      if (targetSize.width > 0 && targetSize.height > 0) {
        options.width = targetSize.width
        options.height = targetSize.height
      }
      if (framerate !== 'source') options.fps = Number(framerate)
      options.quality = quality
    }
    if (!spec?.videoOnly) options.audioCodec = audioCodec
    options.audioBitrate = audioBitrate

    const id = `c_${++taskSeq}`
    runningId.current = id
    setTasks((list) => [
      {
        id,
        input,
        name: base,
        state: {
          status: 'running',
          progress: { progress: 0, outTime: 0, duration: 0, speed: '', eta: '--:--' },
          message: '正在准备…',
          log: []
        }
      },
      ...list
    ])

    try {
      await api.convert.start(options)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTasks((list) =>
        list.map((t) =>
          t.id === id
            ? {
                ...t,
                state: {
                  ...t.state,
                  status: 'error',
                  message
                }
              }
            : t
        )
      )
      toast(message, 'error')
    }
  }

  const cancel = async (): Promise<void> => {
    await api.convert.cancel()
  }

  const importToLibrary = async (path: string): Promise<void> => {
    const imported = await api.media.importPaths([path])
    if (imported.length === 0) return
    const store = useEditor.getState()
    // The import is an edit of the project, so it can be taken back.
    store.pushHistory()
    store.addAssets(imported)
    toast(`已导入 ${imported.length} 个文件`)
  }

  const assetList = Object.values(assets)

  return (
    <div className="tool">
      <div className="tool__col tool__col--source">
        <div className="tool__head">
          <span className="panel-title">源文件</span>
        </div>

        <div className="tool__body">
          {input ? (
            <div className="source-card">
              <div className="source-card__name">{input.split(/[\\/]/).pop()}</div>
              {probe ? (
                <div className="source-card__meta">
                  {probe.width && probe.height ? (
                    <span>
                      {probe.width}×{probe.height}
                    </span>
                  ) : null}
                  {probe.fps ? <span>{probe.fps.toFixed(0)} fps</span> : null}
                  {probe.duration ? <span>{formatDuration(probe.duration)}</span> : null}
                  <span>{probe.codec}</span>
                  {probe.hasAudio ? <span>含音频</span> : <span>无音频</span>}
                </div>
              ) : (
                <div className="source-card__meta">无法读取该文件的信息</div>
              )}
            </div>
          ) : (
            <div className="tool__empty">
              <p className="empty__title">还没有选择文件</p>
              <p className="empty__body">选择一个视频或音频开始转换</p>
            </div>
          )}

          <button className="btn btn--sm" onClick={() => void chooseSource()}>
            选择文件…
          </button>

          {assetList.length > 0 ? (
            <div className="tool__section">
              <div className="label">从媒体库选择</div>
              <select
                className="select"
                value=""
                onChange={(e) => {
                  if (e.target.value) useAsset(e.target.value)
                }}
              >
                <option value="">选择素材…</option>
                {assetList.map((a) => (
                  <option key={a.id} value={a.path}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </div>

      <div className="tool__col tool__col--params">
        <div className="tool__head">
          <span className="panel-title">输出参数</span>
        </div>

        <div className="tool__body">
          <div className="tool__row">
            <span className="tool__label">格式</span>
            <select
              className="select"
              value={format}
              onChange={(e) => pickFormat(e.target.value as ConvertFormat)}
            >
              {FORMAT_ORDER.map((id) => (
                <option key={id} value={id}>
                  {FORMATS[id].label}
                </option>
              ))}
            </select>
          </div>

          {!audioOnly ? (
            <div className="tool__row">
              <span className="tool__label">编码</span>
              <select
                className="select"
                value={videoCodec}
                onChange={(e) => setVideoCodec(e.target.value)}
              >
                {(spec?.videoCodecs ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {!spec?.videoOnly ? (
            <div className="tool__row">
              <span className="tool__label">音频</span>
              <select
                className="select"
                value={audioCodec}
                onChange={(e) => setAudioCodec(e.target.value)}
              >
                {(spec?.audioCodecs ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {!audioOnly ? (
            <>
              <div className="tool__row">
                <span className="tool__label">分辨率</span>
                <select
                  className="select"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  {RESOLUTIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              {resolution === 'custom' ? (
                <div className="tool__row">
                  <span className="tool__label">尺寸</span>
                  <div className="tool__size">
                    <div className="prop__num">
                      <input
                        className="prop__num-input mono"
                        type="number"
                        min={16}
                        max={7680}
                        step={2}
                        value={customWidth}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) setCustomWidth(v)
                        }}
                      />
                      <span className="prop__num-unit">宽</span>
                    </div>
                    <div className="prop__num">
                      <input
                        className="prop__num-input mono"
                        type="number"
                        min={16}
                        max={7680}
                        step={2}
                        value={customHeight}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          if (Number.isFinite(v)) setCustomHeight(v)
                        }}
                      />
                      <span className="prop__num-unit">高</span>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="tool__row">
                <span className="tool__label">帧率</span>
                <select
                  className="select"
                  value={framerate}
                  onChange={(e) => setFramerate(e.target.value)}
                >
                  {FRAMERATES.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="tool__row">
                <span className="tool__label">质量</span>
                <div className="chip-row">
                  {QUALITY.map((q) => (
                    <button
                      key={q.id}
                      className={`chip${quality === q.id ? ' is-active' : ''}`}
                      onClick={() => setQuality(q.id)}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {!spec?.videoOnly ? (
            <div className="tool__row">
              <span className="tool__label">音频码率</span>
              <div className="prop__num">
                <input
                  className="prop__num-input mono"
                  type="number"
                  min={64}
                  max={320}
                  step={32}
                  value={audioBitrate}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v)) setAudioBitrate(v)
                  }}
                />
                <span className="prop__num-unit">kbps</span>
              </div>
            </div>
          ) : null}

          <div className="tool__row">
            <span className="tool__label">输出目录</span>
            <div className="tool__dir">
              <span className="tool__dir-path mono" title={outputDir}>
                {outputDir || '未选择'}
              </span>
              <button
                className="btn btn--sm"
                onClick={async () => {
                  const dir = await api.convert.chooseOutputDir()
                  if (dir) setOutputDir(dir)
                }}
              >
                选择…
              </button>
            </div>
          </div>

          <div className="tool__row">
            <span className="tool__label">文件名</span>
            <input
              className="field"
              value={fileName}
              placeholder={stemOf(input)}
              spellCheck={false}
              onChange={(e) => setFileName(e.target.value)}
            />
          </div>
        </div>

        <div className="tool__foot">
          <button
            className="btn btn--primary"
            disabled={!input || Boolean(runningId.current)}
            onClick={() => void start()}
          >
            {runningId.current ? '转换中…' : '开始转换'}
          </button>
          {runningId.current ? (
            <button className="btn btn--ghost btn--sm" onClick={() => void cancel()}>
              取消
            </button>
          ) : null}
        </div>
      </div>

      <div className="tool__col tool__col--tasks">
        <div className="tool__head">
          <span className="panel-title">任务</span>
          {tasks.length > 0 ? <span className="label">{tasks.length} 个</span> : null}
        </div>

        <div className="tool__body">
          {tasks.length === 0 ? (
            <div className="tool__empty">
              <p className="empty__title">还没有任务</p>
              <p className="empty__body">转换后的文件会出现在这里</p>
            </div>
          ) : (
            <div className="task-list">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onCancel={() => void cancel()}
                  onImport={() => {
                    const path = task.state.outputPath
                    if (path) void importToLibrary(path)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskRow({
  task,
  onCancel,
  onImport
}: {
  task: ConvertTask
  onCancel: () => void
  onImport: () => void
}): React.JSX.Element {
  const { state } = task
  const pct = Math.round(state.progress.progress * 100)
  // Once the file exists it is the output that matters, not the source.
  const written = state.outputPath?.split(/[\\/]/).pop()
  const label = written ?? task.name

  return (
    <div className={`task task--${state.status}`}>
      <div className="task__top">
        <span className="task__name" title={state.outputPath ?? task.input}>
          {label}
        </span>
        <span className="task__status mono">{statusLabel(state.status)}</span>
      </div>

      <div className="task__bar">
        <div
          className="task__bar-fill"
          style={{ width: `${state.status === 'done' ? 100 : pct}%` }}
        />
      </div>

      <div className="task__bottom">
        <span className="task__detail mono">
          {state.status === 'running'
            ? `${pct}% · ${state.progress.eta}`
            : state.message}
        </span>
        <span className="task__actions">
          {state.status === 'running' ? (
            <button className="btn btn--ghost btn--sm" onClick={onCancel}>
              取消
            </button>
          ) : null}
          {state.status === 'done' ? (
            <button className="btn btn--ghost btn--sm" onClick={onImport}>
              导入媒体库
            </button>
          ) : null}
        </span>
      </div>
    </div>
  )
}

/** The name a converted file gets when none is given. */
function stemOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? 'output'
  return base.replace(/\.[^.]+$/, '')
}

function statusLabel(status: ConvertState['status']): string {  switch (status) {
    case 'running':
      return '进行中'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return '等待'
  }
}
