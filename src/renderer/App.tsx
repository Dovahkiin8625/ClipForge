import { useCallback, useEffect, useRef, useState } from 'react'
import { TitleBar } from './components/TitleBar'
import { MediaPanel } from './components/MediaPanel'
import { PreviewPanel } from './components/PreviewPanel'
import { Inspector } from './components/Inspector'
import { TimelinePanel } from './components/timeline/TimelinePanel'
import { ExportDialog } from './components/ExportDialog'
import { FfmpegWarning } from './components/FfmpegWarning'
import { Toasts } from './components/Toasts'
import { ConvertWorkspace } from './components/ConvertWorkspace'
import { DownloadWorkspace } from './components/DownloadWorkspace'
import { useEditor } from './state/store'
import { transport } from './engine/transport'
import { api } from './bridge'
import type { Workspace } from '@shared/workspaces'

const MIN_TIMELINE_H = 140

export function App(): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [timelineH, setTimelineH] = useState(280)
  const [exportOpen, setExportOpen] = useState(false)
  const [resizing, setResizing] = useState(false)
  const [mode, setMode] = useState<Workspace>('edit')

  /* ---------------------------------------------------------------- */
  /* Resizing the timeline pane                                        */
  /* ---------------------------------------------------------------- */

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setResizing(true)
    const startY = e.clientY
    const startH = timelineH

    const onMove = (ev: PointerEvent): void => {
      const next = startH - (ev.clientY - startY)
      const max = window.innerHeight - 200
      setTimelineH(Math.max(MIN_TIMELINE_H, Math.min(max, next)))
    }
    const onUp = (): void => {
      setResizing(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [timelineH])

  /* ---------------------------------------------------------------- */
  /* Export progress                                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const offProgress = api.export.onProgress((p) => {
      const state = useEditor.getState()
      state.setExportState({ ...state.exportState, progress: p })
    })
    const offState = api.export.onState((s) => {
      useEditor.getState().setExportState(s)
    })
    return () => {
      offProgress()
      offState()
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Keyboard shortcuts                                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)

      const store = useEditor.getState()
      const mod = e.ctrlKey || e.metaKey

      // The workspace can be switched from anywhere.
      if (mod && !typing) {
        const digit = e.key
        if (digit === '1') {
          e.preventDefault()
          setMode('edit')
          return
        }
        if (digit === '2') {
          e.preventDefault()
          setMode('convert')
          return
        }
        if (digit === '3') {
          e.preventDefault()
          setMode('download')
          return
        }
      }

      // The editing shortcuts belong to the editing workspace; in the tools
      // they would fire against a timeline that is not even on screen.
      if (mode !== 'edit') return

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) store.redo()
        else store.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        store.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        store.duplicateSelected()
        return
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExportOpen(true)
        return
      }
      if (typing) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          transport.get()?.toggle()
          break
        case 's':
        case 'S':
          e.preventDefault()
          store.splitAtPlayhead()
          break
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          store.deleteSelected()
          break
        case 'ArrowLeft':
          e.preventDefault()
          step(-1, e.shiftKey)
          break
        case 'ArrowRight':
          e.preventDefault()
          step(1, e.shiftKey)
          break
        case 'Home':
          e.preventDefault()
          store.setPlayhead(0)
          break
        case 'End': {
          e.preventDefault()
          const duration = Math.max(
            0,
            ...store.project.tracks.flatMap((t) =>
              t.clips.map((c) => c.start + c.duration)
            )
          )
          store.setPlayhead(duration)
          break
        }
        case '+':
        case '=':
          store.setZoom(store.pxPerSecond * 1.3)
          break
        case '-':
        case '_':
          store.setZoom(store.pxPerSecond / 1.3)
          break
        default:
          break
      }
    }

    const step = (direction: number, big: boolean): void => {
      const store = useEditor.getState()
      const fps = store.project.settings.fps
      const delta = big ? 1 : 1 / fps
      store.setPlayhead(store.playhead + direction * delta)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode])

  return (
    <div className={`app${resizing ? ' is-resizing' : ''}`}>
      <TitleBar
        mode={mode}
        onModeChange={setMode}
        onExport={() => setExportOpen(true)}
      />
      <FfmpegWarning />
      <div className="app__body" ref={bodyRef}>
        {mode === 'edit' ? (
          <>
            <div className="app__upper">
              <MediaPanel />
              <PreviewPanel />
              <Inspector />
            </div>
            <div className="resizer" onPointerDown={startResize} />
            <div className="app__lower" style={{ height: timelineH }}>
              <TimelinePanel />
            </div>
          </>
        ) : (
          <div className="app__tool">
            {/* The tool workspaces stay mounted; only the one in sight is
                shown, so a running download is not interrupted by a switch. */}
            <div className={`tool-pane${mode === 'convert' ? ' is-active' : ''}`}>
              <ConvertWorkspace />
            </div>
            <div className={`tool-pane${mode === 'download' ? ' is-active' : ''}`}>
              <DownloadWorkspace />
            </div>
          </div>
        )}
      </div>
      <Toasts />
      {exportOpen ? <ExportDialog onClose={() => setExportOpen(false)} /> : null}
    </div>
  )
}
