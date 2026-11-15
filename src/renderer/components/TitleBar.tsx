import { useEffect } from 'react'
import { useEditor } from '@/state/store'
import { useProjectIO } from '@/state/projectIO'
import { CanvasSettings } from '@/components/CanvasSettings'
import { api } from '@/bridge'
import type { Workspace } from '@shared/workspaces'

const MODES: { id: Workspace; label: string; title: string }[] = [
  { id: 'edit', label: '剪辑', title: '剪辑工作区 (Ctrl+1)' },
  { id: 'convert', label: '转换', title: '格式转换 (Ctrl+2)' },
  { id: 'download', label: '下载', title: '视频下载 (Ctrl+3)' }
]

export function TitleBar({
  mode,
  onModeChange,
  onExport
}: {
  mode: Workspace
  onModeChange: (mode: Workspace) => void
  onExport: () => void
}): React.JSX.Element {
  const name = useEditor((s) => s.project.name)
  const dirty = useEditor((s) => s.dirty)
  const canUndo = useEditor((s) => s.history.past.length > 0)
  const canRedo = useEditor((s) => s.history.future.length > 0)
  const { open, save, saveAs } = useProjectIO()
  const editing = mode === 'edit'

  // Ctrl+S / Ctrl+O / Ctrl+E are handled globally; these cover the rest.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        if (e.shiftKey) void saveAs()
        else void save()
      } else if (key === 'o') {
        e.preventDefault()
        void open()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, save, saveAs])

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <BrandMark />
        <span className="titlebar__wordmark">ClipForge</span>
      </div>

      <div className="titlebar__project">
        <input
          className="titlebar__name"
          value={name}
          spellCheck={false}
          onChange={(e) =>
            useEditor.getState().mutate((draft) => {
              draft.name = e.target.value
            })
          }
          aria-label="项目名称"
        />
        {dirty ? <span className="titlebar__unsaved" title="有未保存的修改" /> : null}
      </div>

      <div className="titlebar__actions">
        <button
          className="btn btn--ghost btn--icon"
          disabled={!canUndo || !editing}
          onClick={() => useEditor.getState().undo()}
          title="撤销 (Ctrl+Z)"
        >
          <UndoIcon />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          disabled={!canRedo || !editing}
          onClick={() => useEditor.getState().redo()}
          title="重做 (Ctrl+Shift+Z)"
        >
          <RedoIcon />
        </button>
        <span className="titlebar__rule" />
        <button className="btn btn--ghost btn--sm" onClick={() => void open()} title="打开项目 (Ctrl+O)">
          打开
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => void save()} title="保存项目 (Ctrl+S)">
          保存
        </button>
      </div>

      <div className="titlebar__right">
        <div className="segmented segmented--mode" role="tablist" aria-label="工作区">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              className={`segmented__item${mode === m.id ? ' is-active' : ''}`}
              title={m.title}
              onClick={() => onModeChange(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        {editing ? (
          <>
            <CanvasSettings />
            <button
              className="btn btn--primary"
              onClick={onExport}
              title="导出视频 (Ctrl+E)"
              onMouseEnter={() => void api.app.info().catch(() => undefined)}
            >
              导出
            </button>
          </>
        ) : null}
      </div>
    </header>
  )
}

/** The app mark: three frames of film with sprocket holes. */
function BrandMark(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="0.75" y="3.75" width="20.5" height="14.5" rx="2" fill="#171d26" stroke="#2d3745" />
      <rect x="3" y="5" width="16" height="12" rx="1" fill="#0b0e13" />
      <rect x="4.5" y="6.5" width="3.6" height="9" fill="#f2a03d" opacity="0.9" />
      <rect x="9.2" y="6.5" width="3.6" height="9" fill="#f2a03d" opacity="0.55" />
      <rect x="13.9" y="6.5" width="3.6" height="9" fill="#3fd9c0" opacity="0.75" />
      <g fill="#0b0e13">
        <rect x="3" y="1.6" width="2.4" height="1.6" rx="0.5" />
        <rect x="8" y="1.6" width="2.4" height="1.6" rx="0.5" />
        <rect x="13" y="1.6" width="2.4" height="1.6" rx="0.5" />
        <rect x="3" y="18.8" width="2.4" height="1.6" rx="0.5" />
        <rect x="8" y="18.8" width="2.4" height="1.6" rx="0.5" />
        <rect x="13" y="18.8" width="2.4" height="1.6" rx="0.5" />
      </g>
    </svg>
  )
}

function UndoIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M4.4 2.6 2 5l2.4 2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 5h6.2a3.4 3.4 0 0 1 0 6.8H5.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function RedoIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M9.6 2.6 12 5l-2.4 2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 5H5.8a3.4 3.4 0 0 0 0 6.8h2.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
