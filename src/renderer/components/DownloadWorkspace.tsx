import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DownloadSettings,
  DownloadTask,
  VideoChoice,
  VideoEntry,
  VideoFormatOption,
  VideoList,
  YtdlpInfo
} from '@shared/types'
import { useEditor } from '@/state/store'
import { toast } from '@/state/toasts'
import { api } from '@/bridge'
import { formatDuration } from '@/engine/timelineDraw'

/**
 * The parsed links are kept outside the component.
 *
 * The workspace can be left and come back to; the link that was read stays
 * where it was found, so the list is not empty again.
 */
const listCache = new Map<string, VideoList>()

/** How many entries may be added to the queue in one go. */
const BATCH_LIMIT = 20

/** How many entries are read right away after a link is opened. */
const EAGER_ENTRIES = 5

/** The browsers yt-dlp can read a login from. */
const BROWSERS = [
  { id: 'chrome', label: 'Chrome' },
  { id: 'edge', label: 'Edge' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'brave', label: 'Brave' },
  { id: 'chromium', label: 'Chromium' },
  { id: 'vivaldi', label: 'Vivaldi' },
  { id: 'opera', label: 'Opera' },
  { id: 'safari', label: 'Safari' },
  { id: 'whale', label: 'Whale' },
  { id: 'arc', label: 'Arc' }
]

/** The names the sites are known by. */
const SITES: Record<string, string> = {
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  bilibili_multi_video: '哔哩哔哩',
  twitter: 'X',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
  generic: '通用链接'
}

/** The name of the site a link came from. */
function siteName(extractor: string): string {
  if (!extractor) return '视频下载'
  return SITES[extractor] ?? extractor
}

/** What the interface knows about one entry of the list. */
interface EntryState {
  loading: boolean
  error: string
  /** The qualities on offer; empty until the entry has been read. */
  choices: VideoChoice[]
  /** The raw streams; kept so a precise one can still be picked. */
  formats: VideoFormatOption[]
  /** The quality that is picked. */
  selected: string
  /** The name the file will be given. */
  fileName: string
  /** Whether the raw streams are shown. */
  open: boolean
}

function blankState(title: string): EntryState {
  return {
    loading: false,
    error: '',
    choices: [],
    formats: [],
    selected: '',
    fileName: title,
    open: false
  }
}

/**
 * The quality that is picked.
 *
 * It is usually one of the qualities on offer; it may also be a precise
 * stream that was picked out of the raw list.
 */
function chosenChoice(state: EntryState): VideoChoice | null {
  const fromChoices = state.choices.find((c) => c.id === state.selected)
  if (fromChoices) return fromChoices
  const raw = state.formats.find((f) => f.id === state.selected)
  if (!raw) return null
  return {
    id: raw.id,
    label: raw.label,
    ext: raw.ext,
    width: raw.width,
    height: raw.height,
    fps: raw.fps,
    sizeBytes: raw.sizeBytes ?? 0,
    hasAudio: raw.hasAudio
  }
}

/**
 * Which entry of the page a download has to take.
 *
 * A page that holds a single video is downloaded as it is; a page with
 * several of them is addressed by the position of the one that was picked.
 */
function playlistItemOf(list: VideoList, entry: VideoEntry): number | undefined {
  if (list.mode !== 'list' || list.entries.length <= 1) return undefined
  return entry.index
}

/**
 * The download workspace.
 *
 * A link is read before anything is fetched, so the page and everything on
 * it are known before a single byte is downloaded. The list itself lives
 * in the main process, so downloads keep going and the list stays put when
 * another workspace is opened.
 */
export function DownloadWorkspace(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [list, setList] = useState<VideoList | null>(null)
  const [entries, setEntries] = useState<Record<string, EntryState>>({})
  const [settings, setSettings] = useState<DownloadSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [outputDir, setOutputDir] = useState('')
  const [autoImport, setAutoImport] = useState(false)
  const [tasks, setTasks] = useState<DownloadTask[]>([])
  const [binary, setBinary] = useState<YtdlpInfo | null>(null)
  const [update, setUpdate] = useState<{
    current: string
    latest: string
    hasUpdate: boolean
  } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [menu, setMenu] = useState<{ task: DownloadTask; x: number; y: number } | null>(
    null
  )

  const imported = useRef<Set<string>>(new Set())
  const seen = useRef<Set<string>>(new Set())
  const ready = useRef(false)
  const requested = useRef<Set<string>>(new Set())

  /* ---------------------------------------------------------------- */
  /* The binary, the settings and the saved form                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    void api.download.locate().then(setBinary).catch(() => undefined)
    void (async () => {
      const [loaded, fallback] = await Promise.all([
        api.download.settings(),
        api.app.downloadsPath()
      ])
      setSettings(loaded)
      setUrl(loaded.url)
      // A saved folder that is gone falls back to the downloads folder.
      setOutputDir(loaded.outputDir || fallback)
      setAutoImport(loaded.autoImport)
      // The link that was read before is still good.
      if (loaded.url) {
        const cached = listCache.get(loaded.url)
        if (cached) setList(cached)
      }
      ready.current = true
    })()

    // Whether a newer yt-dlp is out. The answer is cached for a while, so
    // this does not ask GitHub every time the workspace is opened.
    void api.download
      .checkUpdate()
      .then((answer) => setUpdate(answer))
      .catch(() => undefined)
  }, [])

  // The list is kept by the main process; the window only shows it.
  useEffect(() => {
    const off = api.download.onTasks((next) => setTasks(next))
    void api.download.tasks().then(setTasks).catch(() => undefined)
    return off
  }, [])

  // The settings of the workspace are the ones of the main process.
  const save = useCallback((patch: Partial<DownloadSettings>): void => {
    void api.download
      .saveSettings(patch)
      .then((next) => setSettings(next))
      .catch(() => undefined)
  }, [])

  // The link is written down, so that it is never lost.
  useEffect(() => {
    if (!ready.current) return
    const timer = setTimeout(() => void api.download.saveSettings({ url }), 400)
    return () => clearTimeout(timer)
  }, [url])

  /* ---------------------------------------------------------------- */
  /* Reading a link                                                    */
  /* ---------------------------------------------------------------- */

  /** Puts a list that was read into the window. */
  const applyList = useCallback((parsed: VideoList): void => {
    listCache.set(parsed.url, parsed)
    setList(parsed)
    setEntries((prev) => {
      const next = { ...prev }
      for (const entry of parsed.entries) {
        const held = prev[entry.id]
        next[entry.id] = {
          ...blankState(entry.title),
          ...held,
          // A link that is read again keeps the qualities that were read
          // for it; the answer of a list carries only the names.
          choices:
            entry.choices.length > 0 ? entry.choices : (held?.choices ?? []),
          formats:
            entry.formats.length > 0 ? entry.formats : (held?.formats ?? []),
          selected:
            held?.selected || entry.choices[0]?.id || held?.choices[0]?.id || ''
        }
      }
      return next
    })
  }, [])

  const parse = useCallback(async (): Promise<void> => {
    const link = url.trim()
    if (!link) {
      toast('请输入链接', 'error')
      return
    }
    setParsing(true)
    try {
      applyList(await api.download.parseList(link))
    } catch (err) {
      setList(null)
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setParsing(false)
    }
  }, [url, applyList])

  /**
   * Reads the page by hand.
   *
   * The way out for a page the extractor does not understand: every
   * stream in the page is offered as a video of its own.
   */
  const scan = useCallback(async (): Promise<void> => {
    const link = url.trim()
    if (!link) {
      toast('请输入链接', 'error')
      return
    }
    setParsing(true)
    try {
      const found = await api.download.scanPage(link)
      applyList(found)
      toast(`页面里找到 ${found.entries.length} 个视频`)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setParsing(false)
    }
  }, [url, applyList])

  /* ---------------------------------------------------------------- */
  /* Reading the qualities of one entry                                */
  /* ---------------------------------------------------------------- */

  const loadEntry = useCallback(
    async (entry: VideoEntry): Promise<VideoChoice[]> => {
      if (!list) return []
      setEntries((prev) => ({
        ...prev,
        [entry.id]: { ...(prev[entry.id] ?? blankState(entry.title)), loading: true }
      }))
      try {
        const full = await api.download.loadEntry(
          list.url,
          playlistItemOf(list, entry)
        )
        setEntries((prev) => {
          const held = prev[entry.id] ?? blankState(entry.title)
          return {
            ...prev,
            [entry.id]: {
              ...held,
              loading: false,
              error: '',
              choices: full.choices,
              formats: full.formats,
              selected: held.selected || full.choices[0]?.id || ''
            }
          }
        })
        return full.choices
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setEntries((prev) => ({
          ...prev,
          [entry.id]: {
            ...(prev[entry.id] ?? blankState(entry.title)),
            loading: false,
            error: message
          }
        }))
        toast(message, 'error')
        return []
      }
    },
    [list]
  )

  // The first entries are read right away, so the common case of a single
  // video is ready to be downloaded without a second click.
  useEffect(() => {
    if (!list) return
    for (const entry of list.entries.slice(0, EAGER_ENTRIES)) {
      if (requested.current.has(entry.id)) continue
      requested.current.add(entry.id)
      if (entry.choices.length === 0) void loadEntry(entry)
    }
  }, [list, loadEntry])

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
    []
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

  const start = useCallback(
    (entry: VideoEntry, choice: VideoChoice, fileName: string): void => {
      if (!list) return
      if (!outputDir) {
        toast('请先选择输出目录', 'error')
        return
      }
      void api.download
        .start({
          // A stream that was found in the page is taken as it is; the
          // page itself is only named as the one it came from.
          url: entry.mediaUrl ?? list.url,
          formatId: entry.mediaUrl ? undefined : choice.id,
          outputDir,
          fileName: fileName || entry.title,
          title: entry.title,
          outputExt: choice.ext,
          playlistItem: entry.mediaUrl ? undefined : playlistItemOf(list, entry),
          referer: entry.mediaUrl ? list.url : undefined
        })
        .then((task) => toast(`已加入队列 ${task.title}`))
        .catch((err: unknown) =>
          toast(err instanceof Error ? err.message : String(err), 'error')
        )
    },
    [list, outputDir]
  )

  const addEntry = (entry: VideoEntry): void => {
    const held = entries[entry.id] ?? blankState(entry.title)
    const choice = chosenChoice(held)
    if (!choice) {
      toast('先选一个画质', 'error')
      return
    }
    start(entry, choice, held.fileName)
  }

  const addAll = async (): Promise<void> => {
    if (!list) return
    const picked = list.entries.slice(0, BATCH_LIMIT)
    if (list.entries.length > BATCH_LIMIT) {
      toast(`一次最多加入 ${BATCH_LIMIT} 个`, 'error')
    }
    for (const entry of picked) {
      const held = entries[entry.id]
      const choices =
        held && held.choices.length > 0 ? held.choices : await loadEntry(entry)
      const choice =
        choices.find((c) => c.id === held?.selected) ?? choices[0]
      if (!choice) continue
      start(entry, choice, held?.fileName || entry.title)
    }
  }

  const pick = (entry: VideoEntry, id: string): void => {
    setEntries((prev) => ({
      ...prev,
      [entry.id]: { ...(prev[entry.id] ?? blankState(entry.title)), selected: id }
    }))
  }

  const toggleRaw = (entry: VideoEntry): void => {
    setEntries((prev) => ({
      ...prev,
      [entry.id]: {
        ...(prev[entry.id] ?? blankState(entry.title)),
        open: !(prev[entry.id]?.open ?? false)
      }
    }))
  }

  /* ---------------------------------------------------------------- */
  /* yt-dlp                                                            */
  /* ---------------------------------------------------------------- */

  const runUpdate = useCallback(async (): Promise<void> => {
    setUpdating(true)
    try {
      const result = await api.download.updateYtdlp()
      toast(`yt-dlp 已更新到 ${result.version}`)
      setBinary(await api.download.locate())
      setUpdate({ current: result.version, latest: result.version, hasUpdate: false })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setUpdating(false)
    }
  }, [])

  const checkUpdate = useCallback((): void => {
    void api.download
      .checkUpdate(true)
      .then((answer) => {
        setUpdate(answer)
        if (!answer.hasUpdate && answer.latest) {
          toast(`yt-dlp 已经是最新版 ${answer.latest}`)
        }
      })
      .catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
  }, [])

  /* ---------------------------------------------------------------- */
  /* Opening a finished file                                           */
  /* ---------------------------------------------------------------- */

  const openTask = useCallback(
    (task: DownloadTask): void => {
      void api.download.open(task.id).catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
    },
    []
  )

  const revealTask = useCallback(
    (task: DownloadTask): void => {
      void api.download.reveal(task.id).catch((err: unknown) =>
        toast(err instanceof Error ? err.message : String(err), 'error')
      )
    },
    []
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

  const rows = useMemo(() => list?.entries ?? [], [list])

  return (
    <div className="tool tool--download">
      <div className="tool__col tool__col--list">
        <div className="tool__head">
          <span className="panel-title">{siteName(list?.extractor ?? '')}</span>
          <div className="download__head">
            {binary?.available ? (
              <>
                <span className="label mono" title={binary.path}>
                  yt-dlp {binary.version}
                </span>
                {update?.hasUpdate ? (
                  <button
                    className="btn btn--sm"
                    disabled={updating}
                    onClick={() => void runUpdate()}
                  >
                    {updating ? '更新中…' : `更新到 ${update.latest}`}
                  </button>
                ) : (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={checkUpdate}
                  >
                    检查更新
                  </button>
                )}
              </>
            ) : null}
            <button
              className={`btn btn--ghost btn--sm${showSettings ? ' is-on' : ''}`}
              onClick={() => setShowSettings(!showSettings)}
            >
              设置
            </button>
          </div>
        </div>

        <div className="tool__body">
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

          <div className="download__bar">
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
            <button
              className="btn btn--primary download__parse"
              disabled={parsing}
              onClick={() => void parse()}
            >
              {parsing ? '解析中…' : '解析'}
            </button>
            <button
              className="btn download__scan"
              disabled={parsing}
              title="自己把页面读一遍，把里面藏着的视频地址找出来"
              onClick={() => void scan()}
            >
              扫页面
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
                  if (dir) {
                    setOutputDir(dir)
                    save({ outputDir: dir })
                  }
                }}
              >
                选择…
              </button>
            </div>
          </div>

          {showSettings && settings ? (
            <div className="download__settings">
              <div className="download__setting">
                <span className="tool__label">浏览器登录</span>
                <select
                  className="select"
                  value={settings.cookiesFromBrowser}
                  onChange={(e) => save({ cookiesFromBrowser: e.target.value })}
                >
                  <option value="">不用</option>
                  {BROWSERS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <span className="download__hint">
                  会员、年龄限制和私密视频要靠它
                </span>
              </div>

              <div className="download__setting">
                <span className="tool__label">cookies 文件</span>
                <div className="tool__dir">
                  <span className="tool__dir-path mono" title={settings.cookiesFile}>
                    {settings.cookiesFile || '未选择'}
                  </span>
                  <button
                    className="btn btn--sm"
                    onClick={async () => {
                      const file = await api.download.chooseCookiesFile()
                      if (file) save({ cookiesFile: file })
                    }}
                  >
                    选择…
                  </button>
                </div>
              </div>

              <div className="download__setting">
                <span className="tool__label">字幕</span>
                <div className="download__inline">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.subtitles}
                      onChange={(e) => save({ subtitles: e.target.checked })}
                    />
                    <span>同时下载</span>
                  </label>
                  <input
                    className="field download__langs"
                    value={settings.subLangs}
                    title="字幕语言，逗号分开"
                    onChange={(e) => save({ subLangs: e.target.value })}
                  />
                </div>
              </div>

              <div className="download__setting">
                <span className="tool__label">同时下载</span>
                <select
                  className="select"
                  value={String(settings.maxParallel)}
                  onChange={(e) => save({ maxParallel: Number(e.target.value) })}
                >
                  <option value="1">1 个</option>
                  <option value="2">2 个</option>
                  <option value="3">3 个</option>
                </select>
              </div>

              <div className="download__setting">
                <span className="tool__label">失败重试</span>
                <select
                  className="select"
                  value={String(settings.retries)}
                  onChange={(e) => save({ retries: Number(e.target.value) })}
                >
                  <option value="0">不重试</option>
                  <option value="1">1 次</option>
                  <option value="2">2 次</option>
                  <option value="3">3 次</option>
                </select>
              </div>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div className="download__section">
              <div className="download__section-head">
                <span className="panel-title">
                  {list?.mode === 'list' ? '这个页面上的视频' : '视频'}
                </span>
                <span className="label">{rows.length} 个</span>
                {rows.length > 1 ? (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void addAll()}
                  >
                    全部加入队列
                  </button>
                ) : null}
              </div>

              <div className="download__entries">
                {rows.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    state={entries[entry.id] ?? blankState(entry.title)}
                    onLoad={() => {
                      requested.current.add(entry.id)
                      void loadEntry(entry)
                    }}
                    onPick={(id) => pick(entry, id)}
                    onToggleRaw={() => toggleRaw(entry)}
                    onAdd={() => addEntry(entry)}
                    onName={(name) =>
                      setEntries((prev) => ({
                        ...prev,
                        [entry.id]: {
                          ...(prev[entry.id] ?? blankState(entry.title)),
                          fileName: name
                        }
                      }))
                    }
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="tool__empty download__empty">
              <p className="empty__title">还没有链接</p>
              <p className="empty__body">
                粘贴一个视频链接，B站、YouTube、X 的视频和播放列表都在这里
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="tool__col tool__col--queue">
        <div className="tool__head">
          <span className="panel-title">下载列表</span>
          {tasks.length > 0 ? <span className="label">{tasks.length} 个</span> : null}
          {tasks.length > 0 ? (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => void api.download.clearFinished()}
            >
              清除
            </button>
          ) : null}
        </div>

        <div className="tool__body">
          {tasks.length === 0 ? (
            <div className="tool__empty">
              <p className="empty__title">还没有下载</p>
              <p className="empty__body">选一个画质就能开始</p>
            </div>
          ) : (
            <div className="task-list">
              {tasks.map((task) => (
                <DownloadRow
                  key={task.id}
                  task={task}
                  onCancel={() => void api.download.cancel(task.id)}
                  onRetry={() => void api.download.retry(task.id)}
                  onOpen={() => openTask(task)}
                  onReveal={() => revealTask(task)}
                  onUpdate={() => void runUpdate()}
                  onUseBrowser={() => {
                    if (!settings?.cookiesFromBrowser) {
                      save({ cookiesFromBrowser: 'chrome' })
                    }
                    void api.download.retry(task.id)
                  }}
                  onReport={() =>
                    window.open('https://github.com/yt-dlp/yt-dlp/issues/new', '_blank')
                  }
                  onContextMenu={(x, y) => {
                    setMenu({ task, x, y })
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="tool__foot">
          <label className="check">
            <input
              type="checkbox"
              checked={autoImport}
              onChange={(e) => {
                setAutoImport(e.target.checked)
                save({ autoImport: e.target.checked })
              }}
            />
            <span>下载完成后导入媒体库</span>
          </label>
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
          onRetry={() => void api.download.retry(menu.task.id)}
          onRemove={() => void api.download.remove(menu.task.id)}
          onCancel={() => void api.download.cancel(menu.task.id)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

/**
 * One video of the list.
 *
 * The row shows what the video is and which qualities are on offer; the
 * streams the site hands out are one click further down.
 */
function EntryRow({
  entry,
  state,
  onLoad,
  onPick,
  onToggleRaw,
  onAdd,
  onName
}: {
  entry: VideoEntry
  state: EntryState
  onLoad: () => void
  onPick: (id: string) => void
  onToggleRaw: () => void
  onAdd: () => void
  onName: (name: string) => void
}): React.JSX.Element {
  return (
    <div className={`dentry${state.open ? ' is-open' : ''}`}>
      <div className="dentry__row">
        <Cover entry={entry} />

        <div className="dentry__main">
          <div className="dentry__head">
            <span className="dentry__title" title={entry.title}>
              {entry.title}
            </span>
            {entry.duration ? (
              <span className="dentry__dur mono">{formatDuration(entry.duration)}</span>
            ) : null}
          </div>

          <div className="dentry__qualities">
            {state.loading ? (
              <span className="qchip is-busy">读取画质…</span>
            ) : null}
            {state.error ? <span className="dentry__error">{state.error}</span> : null}
            {!state.loading && state.choices.length === 0 ? (
              <button className="qchip" onClick={onLoad}>
                读取画质…
              </button>
            ) : null}
            {state.choices.map((c) => (
              <button
                key={c.id}
                className={`qchip${state.selected === c.id ? ' is-active' : ''}`}
                title={`画质 ${c.id}${c.hasAudio ? '' : ' · 无声'}`}
                onClick={() => onPick(c.id)}
              >
                <span className="qchip__label">{c.label}</span>
                {c.sizeBytes > 0 ? (
                  <span className="qchip__size mono">{formatSize(c.sizeBytes)}</span>
                ) : null}
              </button>
            ))}
            {state.formats.length > 0 ? (
              <button className="qchip qchip--more" onClick={onToggleRaw}>
                {state.open ? '收起原始流' : `原始流 ${state.formats.length}`}
              </button>
            ) : null}
          </div>
        </div>

        <div className="dentry__side">
          <input
            className="field dentry__name"
            value={state.fileName === entry.title ? '' : state.fileName}
            placeholder={entry.title}
            title={state.fileName}
            onChange={(e) => onName(e.target.value)}
          />
          <button className="btn btn--sm" onClick={onAdd}>
            加入队列
          </button>
        </div>
      </div>

      {state.open ? (
        <div className="dentry__raw">
          {state.formats.map((f) => (
            <button
              key={f.id}
              className={`rchip${state.selected === f.id ? ' is-active' : ''}`}
              title={f.id}
              onClick={() => onPick(f.id)}
            >
              <span className="rchip__label">{f.label}</span>
              <span className="rchip__meta mono">
                {f.ext}
                {f.vcodec ? ` · ${f.vcodec}` : ''}
                {f.hasAudio ? '' : ' · 无声'}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The picture of a video.
 *
 * It is fetched by the main process and kept close by, because the window
 * may not load a picture from the internet.
 */
function Cover({ entry }: { entry: VideoEntry }): React.JSX.Element {
  const [cover, setCover] = useState('')

  useEffect(() => {
    if (!entry.thumbnail) return
    let alive = true
    void api.download.cover(entry.thumbnail).then((url) => {
      if (alive) setCover(url)
    })
    return () => {
      alive = false
    }
  }, [entry.thumbnail])

  return (
    <div className="dentry__thumb">
      {cover ? (
        <img src={cover} alt="" className="dentry__thumb-img" />
      ) : (
        <span className="dentry__thumb-empty" />
      )}
    </div>
  )
}

function DownloadRow({
  task,
  onCancel,
  onRetry,
  onOpen,
  onReveal,
  onUpdate,
  onUseBrowser,
  onReport,
  onContextMenu
}: {
  task: DownloadTask
  onCancel: () => void
  onRetry: () => void
  onOpen: () => void
  onReveal: () => void
  onUpdate: () => void
  onUseBrowser: () => void
  onReport: () => void
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

      {task.media ? (
        <div className="task__media mono">
          {task.media.height ? `${task.media.height}p` : ''}
          {task.media.duration ? ` · ${formatDuration(task.media.duration)}` : ''}
          {task.media.codec ? ` · ${task.media.codec}` : ''}
          {task.media.sizeBytes ? ` · ${formatSize(task.media.sizeBytes)}` : ''}
          {task.media.hasAudio ? ' · 有声' : ' · 无声'}
        </div>
      ) : null}

      {task.failure ? (
        <div className="task__failure">
          <span className="task__failure-text">{task.failure.hint}</span>
          <span className="task__actions">
            {task.failure.reason === 'auth' ? (
              <button className="btn btn--ghost btn--sm" onClick={onUseBrowser}>
                读浏览器登录
              </button>
            ) : null}
            {task.failure.reason === 'outdated' ? (
              <button className="btn btn--ghost btn--sm" onClick={onUpdate}>
                更新 yt-dlp
              </button>
            ) : null}
            {task.failure.reason === 'unsupported' ? (
              <button className="btn btn--ghost btn--sm" onClick={onReport}>
                反馈
              </button>
            ) : null}
            {task.failure.reason === 'disk' ? (
              <button className="btn btn--ghost btn--sm" onClick={onReveal}>
                打开目录
              </button>
            ) : null}
            <button className="btn btn--ghost btn--sm" onClick={onRetry}>
              重试
            </button>
          </span>
        </div>
      ) : null}
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
  onRetry,
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
  onRetry: () => void
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
  if (task.status === 'error' || task.status === 'cancelled') {
    items.push({ label: '重新下载', action: onRetry })
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

/** A size in bytes, written the way a person would. */
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let at = 0
  while (value >= 1024 && at < units.length - 1) {
    value /= 1024
    at += 1
  }
  return `${value >= 100 || at === 0 ? Math.round(value) : value.toFixed(1)} ${units[at]}`
}
