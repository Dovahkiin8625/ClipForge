import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadTask, VideoInfo, YtdlpInfo } from '@shared/types'
import { useEditor } from '@/state/store'
import { api } from '@/bridge'
import { formatDuration } from '@/engine/timelineDraw'

/**
 * The metadata of a parsed link is kept outside the component.
 *
 * The workspace can be left and come back to; the link that was read stays
 * where it was found, so the panel is not empty again.
 */
const infoCache = new Map<string, VideoInfo>()

/**
 * The download workspace.
 *
 * The link is read before anything is fetched, so the title, the length and
 * the renditions on offer are known before a single byte is downloaded. The
 * list itself lives in the main process, so downloads keep going and the
 * list stays put when another workspace is opened.
 */
export function DownloadWorkspace(): React.JSX.Element {
  const toast = useEditor((s) => s.toast)

  const [url, setUrl] = useState('')
  const [info, setInfo] = useState<VideoInfo | null>(null)
  const [formatId, setFormatId] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [fileName, setFileName] = useState('')
  const [autoImport, setAutoImport] = useState(false)
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [binary, setBinary] = useState<YtdlpInfo | null>(null)
  const [parsing, setParsing] = useState(false)
  const [menu, setMenu] = useState<{ task: DownloadTask; x: number; y: number } | null>(
    null
  )

  const imported = useRef<Set<string>>(new Set())
  const seen = useRef<Set<string>>(new Set())
  const formReady = useRef(false)

  /* ---------------------------------------------------------------- */
  /* The binary and the saved form                                      */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    void api.download.locate().then(setBinary).catch(() => undefined)
    void api.download.getForm().then((form) => {
      setUrl(form.url)
      setFormatId(form.formatId)
      setFileName(form.fileName)
      setOutputDir(form.outputDir)
      setAutoImport(form.autoImport)
      // The link that was read before is still good.
      if (form.url) {
        const cached = infoCache.get(form.url)
        if (cached) setInfo(cached)
      }
      formReady.current = true
    })
    void api.app.downloadsPath().then((p) => {
      setOutputDir((current) => current || p)
    })
  }, [])

  // The list is kept by the main process; the window only shows it.
  useEffect(() => {
    const off = api.download.onTasks((list) => setTasks(list))
    void api.download.tasks().then(setTasks).catch(() => undefined)
    return off
  }, [])

  // The form is saved so that a link is never lost.
  useEffect(() => {
    if (!formReady.current) return
    void api.download.saveForm({ url, formatId, fileName, outputDir, autoImport })
  }, [url, formatId, fileName, outputDir, autoImport])

  /* ---------------------------------------------------------------- */
  /* Reading a link                                                    */
  /* ---------------------------------------------------------------- */

  const parse = useCallback(async (): Promise<void> => {
    const link = url.trim()
    if (!link) {
      toast('请输入链接', 'error')
      return
    }
    setParsing(true)
    try {
      const parsed = await api.download.parse(link)
      infoCache.set(link, parsed)
      setInfo(parsed)
      setFormatId(parsed.formats[0]?.id ?? '')
      setFileName((current) => current || parsed.title)
    } catch (err) {
      setInfo(null)
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setParsing(false)
    }
  }, [url, toast])

  /* ---------------------------------------------------------------- */
  /* The list                                                          */
  /* ---------------------------------------------------------------- */

  const importToLibrary = useCallback(
    async (path: string): Promise<void> => {
      const importedAssets = await api.media.importPaths([path])
      if (importedAssets.length === 0) return
      const store = useEditor.getState()
      // The import is an edit of the project, so it can be taken back.
      store.pushHistory()
      store.addAssets(importedAssets)
      toast(`已导入 ${importedAssets.length} 个文件`)
    },
    [toast]
  )

  // A finished download can be brought into the library on its own. The
  // tasks that were already in the list when the app started are left
  // alone; only the ones that finish from here on are imported.
  useEffect(() => {
    if (!autoImport) return
    for (const task of tasks) {
      const isNew = !seen.current.has(task.id)
      seen.current.add(task.id)
      if (isNew) continue
      if (task.status !== 'done' || !task.outputPath) continue
      if (imported.current.has(task.id)) continue
      imported.current.add(task.id)
      void importToLibrary(task.outputPath)
    }
  }, [tasks, autoImport, importToLibrary])

  const start = (): void => {
    const link = url.trim()
    if (!link) {
      toast('请输入链接', 'error')
      return
    }
    if (!outputDir) {
      toast('请先选择输出目录', 'error')
      return
    }
    void api.download
      .start({
        url: link,
        formatId: formatId || undefined,
        outputDir,
        fileName: fileName || undefined,
        title: info?.title
      })
      .then((task) => toast(`已开始下载 ${task.title}`))
      .catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
  }

  const formats = useMemo(() => info?.formats ?? [], [info])

  /* ---------------------------------------------------------------- */
  /* Opening a finished file                                           */
  /* ---------------------------------------------------------------- */

  const openTask = useCallback(
    (task: DownloadTask): void => {
      void api.download.open(task.id).catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
    },
    [toast]
  )

  const revealTask = useCallback(
    (task: DownloadTask): void => {
      void api.download.reveal(task.id).catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
    },
    [toast]
  )

  // The context menu closes on the next click anywhere else.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [menu])

  return (
    <div className="tool tool--download">
      <div className="download">
        {binary && !binary.available ? (
          <div className="tool__banner">
            <span className="tool__banner-text">{binary.hint}</span>
            <button
              className="btn btn--sm"
              onClick={async () => {
                const next = await api.download.chooseBinary()
                setBinary(next)
                if (next.available) toast(`已找到 yt-dlp ${next.version}`)
              }}
            >
              指定路径
            </button>
          </div>
        ) : null}

        {binary?.available ? (
          <div className="tool__banner tool__banner--quiet">
            <span className="tool__banner-text mono">yt-dlp {binary.version}</span>
          </div>
        ) : null}

        <div className="download__top">
          <div className="download__url">
            <input
              className="field download__url-input"
              value={url}
              placeholder="粘贴视频链接…"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void parse()
              }}
            />
            <button className="btn" disabled={parsing} onClick={() => void parse()}>
              {parsing ? '解析中…' : '解析'}
            </button>
          </div>

          <div className="download__out">
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
        </div>

        {info ? (
          <div className="download__info">
            <div className="download__thumb">
              {info.thumbnail ? (
                <img src={info.thumbnail} alt="" className="download__thumb-img" />
              ) : (
                <span className="download__thumb-empty" />
              )}
            </div>
            <div className="download__meta">
              <div className="download__title">{info.title}</div>
              <div className="download__sub">
                {info.duration ? <span>{formatDuration(info.duration)}</span> : null}
                {info.extractor ? <span>{info.extractor}</span> : null}
                <span>{formats.length} 个可用画质</span>
              </div>
            </div>
            <div className="download__name">
              <span className="tool__label">文件名</span>
              <input
                className="field"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {formats.length > 0 ? (
          <div className="download__formats">
            <span className="panel-title">画质</span>
            <div className="download__format-list">
              {formats.map((f) => (
                <button
                  key={f.id}
                  className={`download__format${formatId === f.id ? ' is-active' : ''}`}
                  onClick={() => setFormatId(f.id)}
                >
                  <span className="download__format-label">{f.label}</span>
                  <span className="download__format-sub mono">
                    {f.ext}
                    {f.hasAudio ? ' · 有声' : ' · 无声'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="download__actions">
          <label className="check">
            <input
              type="checkbox"
              checked={autoImport}
              onChange={(e) => setAutoImport(e.target.checked)}
            />
            <span>下载完成后导入媒体库</span>
          </label>
          <button className="btn btn--primary" onClick={start}>
            下载
          </button>
        </div>

        <div className="download__queue">
          <div className="tool__head">
            <span className="panel-title">下载列表</span>
            {tasks.length > 0 ? <span className="label">{tasks.length} 个</span> : null}
            {tasks.length > 0 ? (
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void api.download.clearFinished()}
              >
                清除已完成
              </button>
            ) : null}
          </div>
          {tasks.length === 0 ? (
            <div className="tool__empty">
              <p className="empty__title">还没有下载</p>
              <p className="empty__body">解析一个链接开始下载</p>
            </div>
          ) : (
            <div className="task-list">
              {tasks.map((task) => (
                <DownloadRow
                  key={task.id}
                  task={task}
                  onCancel={() => void api.download.cancel(task.id)}
                  onOpen={() => openTask(task)}
                  onContextMenu={(x, y) => {
                    setMenu({ task, x, y })
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {menu ? (
        <TaskMenu
          task={menu.task}
          x={menu.x}
          y={menu.y}
          onOpen={() => openTask(menu.task)}
          onReveal={() => revealTask(menu.task)}
          onImport={() => {
            const path = menu.task.outputPath
            if (path) void importToLibrary(path)
          }}
          onRemove={() => void api.download.remove(menu.task.id)}
          onCancel={() => void api.download.cancel(menu.task.id)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

function DownloadRow({
  task,
  onCancel,
  onOpen,
  onContextMenu
}: {
  task: DownloadTask
  onCancel: () => void
  onOpen: () => void
  onContextMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const pct = Math.round(task.progress.progress * 100)
  const finished = task.status === 'done'

  return (
    <div
      className={`task task--${task.status}`}
      onDoubleClick={finished ? onOpen : undefined}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e.clientX, e.clientY)
      }}
      title={finished ? '双击打开文件' : undefined}
    >
      <div className="task__top">
        <span className="task__name" title={task.url}>
          {task.title}
        </span>
        <span className="task__status mono">{statusLabel(task.status)}</span>
      </div>

      <div className="task__bar">
        <div
          className="task__bar-fill"
          style={{ width: `${finished ? 100 : pct}%` }}
        />
      </div>

      <div className="task__bottom">
        <span className="task__detail mono">
          {task.status === 'running'
            ? `${pct}% · ${task.progress.speed || ''} · ${task.progress.eta}`
            : task.message}
        </span>
        <span className="task__actions">
          {task.status === 'running' || task.status === 'queued' ? (
            <button className="btn btn--ghost btn--sm" onClick={onCancel}>
              取消
            </button>
          ) : null}
          {finished ? (
            <button className="btn btn--ghost btn--sm" onClick={onOpen}>
              打开
            </button>
          ) : null}
        </span>
      </div>
    </div>
  )
}

interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
}

function TaskMenu({
  task,
  x,
  y,
  onOpen,
  onReveal,
  onImport,
  onRemove,
  onCancel,
  onClose
}: {
  task: DownloadTask
  x: number
  y: number
  onOpen: () => void
  onReveal: () => void
  onImport: () => void
  onRemove: () => void
  onCancel: () => void
  onClose: () => void
}): React.JSX.Element {
  const items: MenuItem[] = []

  if (task.status === 'done') {
    items.push({ label: '打开文件', action: onOpen })
    items.push({ label: '打开文件所在目录', action: onReveal })
    items.push({ label: '导入媒体库', action: onImport })
  }
  if (task.status === 'running' || task.status === 'queued') {
    items.push({ label: '取消下载', action: onCancel })
  }
  items.push({ label: '复制链接', action: () => void navigator.clipboard.writeText(task.url) })
  items.push({ label: '从列表移除', action: onRemove, danger: true })

  // The menu must not run off the edge of the window.
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - items.length * 32 - 16)

  return (
    <div
      className="menu"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
          onClick={() => {
            item.action()
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function statusLabel(status: DownloadTask['status']): string {
  switch (status) {
    case 'parsing':
      return '解析中'
    case 'queued':
      return '等待中'
    case 'running':
      return '下载中'
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
