import { useRef, useState } from 'react'
import type { AnimatableProperty, Clip } from '@shared/types'
import { useEditor } from '@/state/store'
import { evaluateKeyframes } from '@/engine/keyframes'

export interface PropertyRowProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number, options?: { silent?: boolean }) => void
  /** When set, the property can be keyframed. */
  property?: AnimatableProperty
  clip?: Clip
  /** Multiplier between the stored value and the number shown in the field. */
  unitScale?: number
  /** Unit printed next to the number. */
  unit?: string
}

/**
 * A slider with a number field next to it.
 *
 * One drag of the slider or one burst of typing is a single undo step: the
 * first edit records the history, the rest are applied silently.
 */
export function PropertyRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  property,
  clip,
  unitScale = 1,
  unit = ''
}: PropertyRowProps): React.JSX.Element {
  const playhead = useEditor((s) => s.playhead)
  const keys = clip && property ? clip.keyframes[property] : []
  const animated = keys.length > 0

  const localTime = clip ? playhead - clip.start : 0
  const inRange = clip ? localTime >= -0.001 && localTime <= clip.duration + 0.001 : false
  const hasKeyAt = keys.some((k) => Math.abs(k.t - localTime) <= 0.02)

  // When a property is animated the slider shows the value at the playhead.
  const effective = animated ? evaluateKeyframes(keys, localTime, value) : value

  // One drag of the slider or one burst of typing is a single undo step:
  // the first edit records the history, the rest are applied silently.
  const sessionRef = useRef(false)

  const applyValue = (v: number): void => {
    if (!sessionRef.current) {
      sessionRef.current = true
      useEditor.getState().pushHistory()
    }
    if (property && clip && animated && inRange) {
      // An animated property is edited on its curve, not on its base value.
      useEditor
        .getState()
        .setKeyframeValue(clip.id, property, Math.max(0, localTime), v, { silent: true })
      return
    }
    onChange(v, { silent: true })
  }

  const endSession = (): void => {
    sessionRef.current = false
  }

  const focusClip = (): void => {
    // Every new interaction is its own undo step — the session flag is
    // cleared here rather than on blur, which is not always delivered.
    sessionRef.current = false
    if (!clip) return
    // Edits are only visible in the preview when the playhead sits on the
    // clip, so move it there before the user starts changing anything.
    const t = useEditor.getState().playhead
    if (t >= clip.start - 0.001 && t <= clip.start + clip.duration + 0.001) return
    useEditor.getState().setPlayhead(clip.start)
  }

  return (
    <div className="prop">
      <div className="inspector__row">
        <span className="inspector__label">{label}</span>
        {property && clip ? (
          <button
            className={`kf-btn${animated ? ' is-animated' : ''}${hasKeyAt ? ' is-set' : ''}`}
            title={
              animated
                ? '在播放头处添加/删除关键帧'
                : '在播放头处添加关键帧'
            }
            disabled={!inRange}
            onClick={() =>
              useEditor
                .getState()
                .toggleKeyframe(clip.id, property, Math.max(0, localTime), effective)
            }
          >
            <DiamondIcon />
          </button>
        ) : null}
        <NumberField
          label={label}
          value={effective}
          min={min}
          max={max}
          step={step}
          unitScale={unitScale}
          unit={unit}
          onFocus={focusClip}
          onInput={applyValue}
          onCommit={endSession}
        />
      </div>

      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={effective}
        onPointerDown={focusClip}
        onPointerUp={endSession}
        onBlur={endSession}
        onChange={(e) => applyValue(Number(e.target.value))}
        aria-label={label}
      />

      {animated && clip ? (
        <KeyframeStrip
          clip={clip}
          property={property!}
          keys={keys}
          currentTime={localTime}
        />
      ) : null}
    </div>
  )
}

/**
 * A number field that can be typed into directly.
 *
 * While it has the focus it keeps the raw text the user typed — otherwise
 * every keystroke would be reformatted and the caret would jump. The value
 * is pushed to the document on every keystroke, so the preview follows along
 * while the number is being typed.
 */
function NumberField({
  label,
  value,
  min,
  max,
  step,
  unitScale,
  unit,
  onFocus,
  onInput,
  onCommit
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unitScale: number
  unit: string
  onFocus: () => void
  onInput: (v: number) => void
  onCommit: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const display = draft ?? formatNumber(value * unitScale)

  const apply = (raw: string): void => {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === '-') return
    const n = Number(trimmed)
    if (!Number.isFinite(n)) return
    const v = Math.min(max, Math.max(min, n / unitScale))
    onInput(v)
  }

  return (
    <div className="prop__num">
      <input
        className="prop__num-input mono"
        type="number"
        min={min * unitScale}
        max={max * unitScale}
        step={step * unitScale}
        value={display}
        aria-label={label}
        onFocus={onFocus}
        onChange={(e) => {
          setDraft(e.target.value)
          apply(e.target.value)
        }}
        onBlur={() => {
          setDraft(null)
          onCommit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      {unit ? <span className="prop__num-unit">{unit}</span> : null}
    </div>
  )
}

/** Formats a number for the small value fields: no trailing zeroes, no noise. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n * 1000) / 1000
  return String(rounded)
}

function KeyframeStrip({
  clip,
  property,
  keys,
  currentTime
}: {
  clip: Clip
  property: AnimatableProperty
  keys: { t: number; value: number }[]
  currentTime: number
}): React.JSX.Element {
  const width = Math.max(clip.duration, 0.001)

  return (
    <div className="kf-strip" title="关键帧">
      <div className="kf-strip__line" />
      {keys.map((k) => (
        <button
          key={`${k.t}-${k.value}`}
          className="kf-strip__dot"
          style={{ left: `${(k.t / width) * 100}%` }}
          title={`${k.t.toFixed(2)}s · ${k.value.toFixed(2)}`}
          onClick={() => {
            const store = useEditor.getState()
            store.setPlayhead(clip.start + k.t)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            useEditor.getState().removeKeyframe(clip.id, property, k.t)
          }}
        />
      ))}
      <div
        className="kf-strip__cursor"
        style={{ left: `${(Math.max(0, Math.min(width, currentTime)) / width) * 100}%` }}
      />
    </div>
  )
}

function DiamondIcon(): React.JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path d="M5.5 1.6 9.4 5.5 5.5 9.4 1.6 5.5 5.5 1.6Z" fill="currentColor" />
    </svg>
  )
}
