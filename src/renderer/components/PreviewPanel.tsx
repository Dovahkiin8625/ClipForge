import { useEffect, useRef, useState } from 'react'
import type { AnimatableProperty, Clip } from '@shared/types'
import { useEditor } from '@/state/store'
import { PreviewEngine, type HandleKind } from '@/engine/previewEngine'
import { transport } from '@/engine/transport'
import { formatTimecode } from '@/engine/timelineDraw'
import { projectDuration } from '@/engine/timeline'

/** The corners of a clip, clockwise from the top left. */
const CORNERS = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 }
]

/** What the pointer is holding while it is dragged. */
interface Drag {
  kind: HandleKind
  corner: number
  clipId: string
  /** Where the pointer started, in the coordinates of the project. */
  startX: number
  startY: number
  /** The middle of the clip when the drag started. */
  centerX: number
  centerY: number
  /** The size of the clip, before it is turned. */
  width: number
  height: number
  /** The transform when the drag started. */
  origin: { x: number; y: number; scale: number; rotation: number }
  /** The angle of the pointer at the start, in radians. */
  angle: number
}

export function PreviewPanel(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const selectedId = useEditor((s) =>
    s.selectedClipIds.length === 1 ? s.selectedClipIds[0] : null
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [cursor, setCursor] = useState('default')
  const hasClips = project.tracks.some((t) => t.clips.length > 0)

  // The engine is created once; it keeps its own clock and media elements.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new PreviewEngine(canvas, useEditor.getState().project, {
      onTick: (t) => useEditor.getState().setPlayhead(t),
      onEnded: () => useEditor.getState().setPlaying(false)
    })
    engineRef.current = engine
    transport.set(engine)
    engine.primeAssets()
    engine.seek(useEditor.getState().playhead)
    // Exposed so that the preview can be driven from the devtools console
    // and from the feature checks.
    ;(window as unknown as { __clipforgePreview?: PreviewEngine }).__clipforgePreview = engine
    return () => {
      transport.set(null)
      engine.dispose()
      engineRef.current = null
      delete (window as unknown as { __clipforgePreview?: PreviewEngine }).__clipforgePreview
    }
  }, [])

  useEffect(() => {
    engineRef.current?.setProject(project)
  }, [project])

  // The handles belong to the selected clip.
  useEffect(() => {
    engineRef.current?.setSelection(selectedId)
  }, [selectedId])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (engine.isPlaying) {
      // While playing the engine drives the clock; a large divergence means
      // the user scrubbed, so re-anchor it.
      if (Math.abs(engine.currentTime - playhead) > 0.12) engine.seek(playhead)
    } else {
      engine.seek(playhead)
    }
  }, [playhead])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (playing) engine.play()
    else engine.pause()
  }, [playing])

  /* ---------------------------------------------------------------- */
  /* Dragging the clip in the picture                                 */
  /* ---------------------------------------------------------------- */

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const engine = engineRef.current
    if (!engine) return
    const point = engine.toProject(e.clientX, e.clientY)
    const hit = engine.pick(point.x, point.y)
    const overlay = engine.overlay()
    if (!hit || !overlay) return

    const store = useEditor.getState()
    const clip = findClip(store.project, overlay.clipId)
    if (!clip) return

    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    // One drag is one step in the history.
    store.pushHistory()

    dragRef.current = {
      kind: hit.kind,
      corner: hit.corner,
      clipId: clip.id,
      startX: point.x,
      startY: point.y,
      centerX: overlay.center.x,
      centerY: overlay.center.y,
      width: overlay.width,
      height: overlay.height,
      origin: {
        x: clip.transform.x,
        y: clip.transform.y,
        scale: overlay.scale,
        rotation: overlay.rotation
      },
      angle: Math.atan2(point.y - overlay.center.y, point.x - overlay.center.x)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const engine = engineRef.current
    if (!engine) return
    const point = engine.toProject(e.clientX, e.clientY)
    const drag = dragRef.current

    if (!drag) {
      // Nothing is being dragged: show what the pointer would grab.
      const hit = engine.pick(point.x, point.y)
      setCursor(cursorFor(hit?.kind, hit?.corner ?? -1))
      return
    }

    const store = useEditor.getState()
    const clip = findClip(store.project, drag.clipId)
    if (!clip) return
    const { width: W, height: H } = store.project.settings

    if (drag.kind === 'move') {
      const cx = drag.centerX + (point.x - drag.startX)
      const cy = drag.centerY + (point.y - drag.startY)
      applyValue(clip, 'x', (cx - W / 2) / (W / 2))
      applyValue(clip, 'y', (cy - H / 2) / (H / 2))
      return
    }

    if (drag.kind === 'scale') {
      // The distance from the middle decides how big the clip becomes.
      const from = Math.hypot(drag.startX - drag.centerX, drag.startY - drag.centerY)
      const to = Math.hypot(point.x - drag.centerX, point.y - drag.centerY)
      if (from < 1) return
      const scale = Math.min(4, Math.max(0.1, drag.origin.scale * (to / from)))

      // The corner that is being held stays under the pointer.
      const corner = CORNERS[drag.corner]
      const rad = (drag.origin.rotation * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const lx = (corner.x * drag.width * (scale / drag.origin.scale)) / 2
      const ly = (corner.y * drag.height * (scale / drag.origin.scale)) / 2
      const cx = point.x - (lx * cos - ly * sin)
      const cy = point.y - (lx * sin + ly * cos)

      applyValue(clip, 'scale', scale)
      applyValue(clip, 'x', (cx - W / 2) / (W / 2))
      applyValue(clip, 'y', (cy - H / 2) / (H / 2))
      return
    }

    // Turning the clip.
    const angle = Math.atan2(point.y - drag.centerY, point.x - drag.centerX)
    let degrees = drag.origin.rotation + ((angle - drag.angle) * 180) / Math.PI
    if (e.shiftKey) degrees = Math.round(degrees / 15) * 15
    useEditor.getState().setClipTransform(clip.id, { rotation: degrees }, { silent: true })
  }

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current) {
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      setCursor('default')
    }
  }

  const duration = projectDuration(project)

  return (
    <section className="preview">
      <div className="preview__stage">
        {/* The canvas is always mounted: the preview engine is created once
            against it, so unmounting it would tear the engine down. */}
        <canvas
          ref={canvasRef}
          className="preview__canvas"
          style={{ cursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        {!hasClips ? (
          <div className="preview__empty">
            <svg width="96" height="96" viewBox="0 0 72 72" fill="none" aria-hidden="true">
              <circle cx="36" cy="36" r="34" stroke="#242c38" strokeWidth="1" />
              <circle cx="36" cy="36" r="23" stroke="#2d3745" strokeWidth="1" />
              <path d="M36 2v68M2 36h68" stroke="#1c232e" strokeWidth="1" />
              <path d="M12 12l48 48M60 12L12 60" stroke="#161c25" strokeWidth="1" />
              <text
                x="36"
                y="48"
                textAnchor="middle"
                fill="#f2a03d"
                fontSize="30"
                fontFamily="IBM Plex Mono, monospace"
                opacity="0.75"
              >
                3
              </text>
            </svg>
            <p className="preview__empty-title">导入素材后开始剪辑</p>
            <p className="preview__empty-body">
              从左侧媒体库拖拽素材到下方时间轴
            </p>
          </div>
        ) : null}
      </div>

      <div className="transport">
        <div className="transport__group">
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => useEditor.getState().setPlayhead(0)}
            title="跳到开头 (Home)"
          >
            <SkipStartIcon />
          </button>
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => step(-1)}
            title="上一帧 (←)"
          >
            <StepBackIcon />
          </button>
          <button
            className="btn btn--transport-play"
            onClick={() => useEditor.getState().setPlaying(!playing)}
            title="播放 / 暂停 (空格)"
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => step(1)}
            title="下一帧 (→)"
          >
            <StepForwardIcon />
          </button>
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => useEditor.getState().setPlayhead(duration)}
            title="跳到结尾 (End)"
          >
            <SkipEndIcon />
          </button>
        </div>

        <div className="transport__time mono">
          <span className="transport__current">{formatTimecode(playhead, project.settings.fps)}</span>
          <span className="transport__slash">/</span>
          <span className="transport__total">{formatTimecode(duration, project.settings.fps)}</span>
        </div>

        <div className="transport__group transport__group--right">
          <span className="label">
            {project.settings.width}×{project.settings.height} · {project.settings.fps}fps
          </span>
        </div>
      </div>
    </section>
  )
}

/** Finds a clip in the project. */
function findClip(
  project: { tracks: { clips: Clip[] }[] },
  clipId: string
): Clip | null {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) return clip
    }
  }
  return null
}

/**
 * Writes a value into the clip.
 *
 * A property that has keyframes is edited on its curve, the same way the
 * inspector does it.
 */
function applyValue(clip: Clip, property: AnimatableProperty, value: number): void {
  const store = useEditor.getState()
  const local = store.playhead - clip.start
  const keys = clip.keyframes[property]
  if (keys.length > 0 && local >= -0.001 && local <= clip.duration + 0.001) {
    store.setKeyframeValue(clip.id, property, Math.max(0, local), value, { silent: true })
    return
  }
  if (property === 'scale') store.setClipTransform(clip.id, { scale: value }, { silent: true })
  else if (property === 'x') store.setClipTransform(clip.id, { x: value }, { silent: true })
  else if (property === 'y') store.setClipTransform(clip.id, { y: value }, { silent: true })
}

/** The cursor that shows what the pointer would grab. */
function cursorFor(kind: HandleKind | undefined, corner: number): string {
  if (kind === 'move') return 'move'
  if (kind === 'rotate') return 'crosshair'
  if (kind === 'scale') return corner === 0 || corner === 2 ? 'nwse-resize' : 'nesw-resize'
  return 'default'
}

function step(direction: number): void {
  const store = useEditor.getState()
  const fps = store.project.settings.fps
  store.setPlayhead(store.playhead + direction / fps)
}

function PlayIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M4 2.4 11.4 7 4 11.6V2.4Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="3.6" y="2.6" width="2.6" height="8.8" rx="0.8" fill="currentColor" />
      <rect x="7.8" y="2.6" width="2.6" height="8.8" rx="0.8" fill="currentColor" />
    </svg>
  )
}

function StepBackIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M4.6 2.6v8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11 2.8 5.4 7 11 11.2V2.8Z" fill="currentColor" />
    </svg>
  )
}

function StepForwardIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M9.4 2.6v8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 2.8 8.6 7 3 11.2V2.8Z" fill="currentColor" />
    </svg>
  )
}

function SkipStartIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3.6 2.6v8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M11.4 2.8 5.8 7l5.6 4.2V2.8Z" fill="currentColor" />
    </svg>
  )
}

function SkipEndIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M10.4 2.6v8.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M2.6 2.8 8.2 7l-5.6 4.2V2.8Z" fill="currentColor" />
    </svg>
  )
}
