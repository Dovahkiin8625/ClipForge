import { useMemo, useRef, useState } from 'react'
import type { Clip, SpeedKeyframe } from '@shared/types'
import {
  clampSpeed,
  clipSourceDuration,
  curveRateAt,
  MAX_SPEED,
  MIN_SPEED,
  sourceAtOffset
} from '@shared/speed'
import { useEditor } from '@/state/store'

/**
 * The curve editor of the speed tab.
 *
 * The horizontal axis is the stretch of source the clip covers — the curve
 * is anchored to the media, not to the timeline, so trimming the clip cuts
 * the curve instead of stretching it. The vertical axis is the playback
 * rate.
 */
export function SpeedCurveEditor({ clip }: { clip: Clip }): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)

  const width = 244
  const height = 118
  const pad = { left: 24, right: 10, top: 10, bottom: 18 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  /** The keyframes as they are stored — the drag edits them in place. */
  const stored = clip.speedKeyframes ?? []
  /** The same keyframes in time order, which is how they are drawn. */
  const keys = useMemo(
    () => [...stored].sort((a, b) => a.t - b.t),
    [stored]
  )
  const sourceStart = clip.inPoint
  const sourceLength = Math.max(0.001, clipSourceDuration(clip))
  /** The keyframes the clip actually shows — the rest lie outside it. */
  const visible = useMemo(
    () =>
      keys.filter(
        (k) => k.t >= sourceStart - 1e-6 && k.t <= sourceStart + sourceLength + 1e-6
      ),
    [keys, sourceStart, sourceLength]
  )

  const topRate = Math.max(4, Math.ceil(Math.max(...visible.map((k) => k.value), 1)))

  const sourceToX = (s: number): number =>
    pad.left + ((s - sourceStart) / sourceLength) * plotW
  const xToSource = (x: number): number =>
    sourceStart + ((x - pad.left) / plotW) * sourceLength
  const rateToY = (rate: number): number =>
    height - pad.bottom - (rate / topRate) * plotH
  const yToRate = (y: number): number =>
    ((height - pad.bottom - y) / plotH) * topRate

  /** The curve drawn as a line: flat outside its own keyframes. */
  const path = useMemo(() => {
    const points: string[] = []
    const push = (x: number, y: number): void => {
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
    }
    if (keys.length === 0) {
      const y = rateToY(clip.speed)
      push(pad.left, y)
      push(width - pad.right, y)
    } else {
      push(pad.left, rateToY(curveRateAt(keys, sourceStart)))
      for (const key of visible) {
        push(sourceToX(key.t), rateToY(key.value))
      }
      push(width - pad.right, rateToY(curveRateAt(keys, sourceStart + sourceLength)))
    }
    return points.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, visible, sourceStart, sourceLength, topRate, clip.speed])

  const commit = (next: SpeedKeyframe[]): void => {
    useEditor.getState().setClipSpeedCurve(clip.id, next, { silent: true })
  }

  const pointerPosition = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    const { x, y } = pointerPosition(e)
    const hit = visible.find(
      (k) => Math.abs(sourceToX(k.t) - x) <= 8 && Math.abs(rateToY(k.value) - y) <= 8
    )
    const index = hit ? stored.indexOf(hit) : -1

    if (index >= 0) {
      dragRef.current = { index, moved: false }
      setDragging(true)
      svgRef.current?.setPointerCapture(e.pointerId)
      return
    }

    if (x < pad.left || x > width - pad.right || y < pad.top || y > height - pad.bottom) return

    // An empty spot on the plot adds a keyframe right there.
    const t = Math.min(sourceStart + sourceLength, Math.max(sourceStart, xToSource(x)))
    const value = clampSpeed(yToRate(y))
    useEditor.getState().pushHistory()
    commit([...stored, { t, value }].sort((a, b) => a.t - b.t))
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = pointerPosition(e)
    const next = [...stored]
    const current = next[drag.index]
    if (!current) return
    // The history is recorded when the keyframe actually moves, so a plain
    // click does not leave an empty undo step behind.
    if (!drag.moved) {
      drag.moved = true
      useEditor.getState().pushHistory()
    }
    next[drag.index] = {
      t: Math.min(sourceStart + sourceLength, Math.max(sourceStart, xToSource(x))),
      value: clampSpeed(yToRate(y))
    }
    commit(next)
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setDragging(false)
    svgRef.current?.releasePointerCapture(e.pointerId)
    if (!drag.moved) return
    // The curve is stored in time order; the drag may have moved a keyframe
    // past its neighbour.
    commit([...stored].sort((a, b) => a.t - b.t))
  }

  // Where the playhead sits on the curve, so the user can see the rate the
  // picture is running at right now.
  const playhead = useEditor((s) => s.playhead)
  const playheadX = sourceToX(sourceAtOffset(clip, playhead - clip.start))

  return (
    <div className="speedcurve">
      <svg
        ref={svgRef}
        className={`speedcurve__svg${dragging ? ' is-dragging' : ''}`}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        role="application"
        aria-label="速度曲线"
        tabIndex={0}
      >
        <rect
          className="speedcurve__bg"
          x={pad.left}
          y={pad.top}
          width={plotW}
          height={plotH}
          rx="3"
        />

        {/* Rate grid. */}
        {[1, 2, 4].filter((r) => r <= topRate).map((rate) => (
          <g key={rate}>
            <line
              className={`speedcurve__grid${rate === 1 ? ' is-base' : ''}`}
              x1={pad.left}
              x2={width - pad.right}
              y1={rateToY(rate)}
              y2={rateToY(rate)}
            />
            <text className="speedcurve__label" x={pad.left - 5} y={rateToY(rate) + 3}>
              {rate}×
            </text>
          </g>
        ))}

        <polyline className="speedcurve__line" points={path} />

        {playhead >= clip.start - 0.001 && playhead <= clip.start + clip.duration + 0.001 ? (
          <line
            className="speedcurve__playhead"
            x1={Math.min(width - pad.right, Math.max(pad.left, playheadX))}
            x2={Math.min(width - pad.right, Math.max(pad.left, playheadX))}
            y1={pad.top}
            y2={height - pad.bottom}
          />
        ) : null}

        {visible.map((key, index) => (
          <g key={`${key.t}-${index}`}>
            <circle
              className="speedcurve__dot"
              cx={sourceToX(key.t)}
              cy={rateToY(key.value)}
              r={4.5}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                useEditor.getState().removeSpeedKeyframe(clip.id, key.t)
              }}
            />
            <title>{`${key.t.toFixed(2)}s · ${key.value.toFixed(2)}×（右键删除）`}</title>
          </g>
        ))}
      </svg>

      <p className="speedcurve__hint">拖动圆点调整速度 · 点击空白处添加关键帧 · 右键圆点删除</p>
      <p className="speedcurve__hint speedcurve__hint--dim">
        速度范围 {MIN_SPEED}× – {MAX_SPEED}×
      </p>
    </div>
  )
}
