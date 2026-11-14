import { useState } from 'react'
import type { Clip, SpeedKeyframe } from '@shared/types'
import {
  averageSpeed,
  clipSourceDuration,
  MAX_SPEED,
  MIN_SPEED
} from '@shared/speed'
import { useEditor, selectPrimaryClip } from '@/state/store'
import { evaluateKeyframes } from '@/engine/keyframes'
import { formatDuration } from '@/engine/timelineDraw'
import { SpeedCurveEditor } from '@/components/SpeedCurve'
import { PropertyRow } from '@/components/PropertyRow'
import { AdjustmentsSection } from '@/components/Adjustments'

export function Inspector(): React.JSX.Element {
  const clip = useEditor(selectPrimaryClip)
  const selectedCount = useEditor((s) => s.selectedClipIds.length)
  const tab = useEditor((s) => s.activeInspectorTab)

  return (
    <aside className="inspector">
      <div className="inspector__tabs" role="tablist">
        {(
          [
            ['transform', '变换'],
            ['composite', '合成'],
            ['adjust', '调整'],
            ['speed', '变速'],
            ['audio', '音频']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`inspector__tab${tab === key ? ' is-active' : ''}`}
            onClick={() => useEditor.getState().setInspectorTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="inspector__body">
        {!clip ? (
          <div className="inspector__empty">
            <p className="inspector__empty-title">
              {selectedCount > 1 ? `已选中 ${selectedCount} 个片段` : '未选中片段'}
            </p>
            <p className="inspector__empty-body">
              在时间轴上点击一个片段即可调整它的属性
            </p>
          </div>
        ) : (
          <>
            <ClipSummary clip={clip} />
            {tab === 'transform' ? <TransformSection clip={clip} /> : null}
            {tab === 'composite' ? <CompositeSection clip={clip} /> : null}
            {tab === 'adjust' ? <AdjustmentsSection clip={clip} /> : null}
            {tab === 'speed' ? <SpeedSection clip={clip} /> : null}
            {tab === 'audio' ? <AudioSection clip={clip} /> : null}
          </>
        )}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

function ClipSummary({ clip }: { clip: Clip }): React.JSX.Element {
  const asset = useEditor((s) => s.project.assets[clip.assetId])
  return (
    <section className="inspector__section">
      <div className="inspector__row inspector__row--stack">
        <span className="inspector__name" title={asset?.name}>
          {clip.label ?? asset?.name ?? '片段'}
        </span>
        <span className="inspector__sub mono">
          {formatDuration(clip.duration)} · 起 {formatDuration(clip.start)}
        </span>
      </div>
    </section>
  )
}

function TransformSection({ clip }: { clip: Clip }): React.JSX.Element {
  const transform = clip.transform

  return (
    <>
      <section className="inspector__section">
        <h3 className="panel-title">位置</h3>
        <PropertyRow
          label="水平"
          property="x"
          clip={clip}
          value={transform.x}
          min={-1}
          max={1}
          step={0.01}
          unitScale={100}
          unit="%"
          onChange={(v, options) => useEditor.getState().setClipProperty(clip.id, 'x', v, options)}
        />
        <PropertyRow
          label="垂直"
          property="y"
          clip={clip}
          value={transform.y}
          min={-1}
          max={1}
          step={0.01}
          unitScale={100}
          unit="%"
          onChange={(v, options) => useEditor.getState().setClipProperty(clip.id, 'y', v, options)}
        />
      </section>

      <section className="inspector__section">
        <h3 className="panel-title">缩放与旋转</h3>
        <PropertyRow
          label="缩放"
          property="scale"
          clip={clip}
          value={transform.scale}
          min={0.1}
          max={4}
          step={0.01}
          unitScale={100}
          unit="%"
          onChange={(v, options) => useEditor.getState().setClipProperty(clip.id, 'scale', v, options)}
        />
        <PropertyRow
          label="旋转"
          value={transform.rotation}
          min={-180}
          max={180}
          step={1}
          unit="°"
          onChange={(v, options) =>
            useEditor.getState().setClipTransform(clip.id, { rotation: v }, options)
          }
        />
      </section>
    </>
  )
}

function CompositeSection({ clip }: { clip: Clip }): React.JSX.Element {
  return (
    <section className="inspector__section">
      <h3 className="panel-title">不透明度</h3>
      <PropertyRow
        label="透明度"
        property="opacity"
        clip={clip}
        value={clip.opacity}
        min={0}
        max={1}
        step={0.01}
        unitScale={100}
        unit="%"
        onChange={(v, options) =>
          useEditor.getState().setClipProperty(clip.id, 'opacity', v, options)
        }
      />
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Speed                                                               */
/* ------------------------------------------------------------------ */

function SpeedSection({ clip }: { clip: Clip }): React.JSX.Element {
  const curve = clip.speedKeyframes ?? []
  const curved = curve.length > 0
  const sourceStart = clip.inPoint
  const sourceLength = Math.max(0.001, clipSourceDuration(clip))

  const switchMode = (mode: 'constant' | 'curve'): void => {
    const store = useEditor.getState()
    if (mode === 'constant') {
      if (!curved) return
      // Going back to a constant rate keeps the clip roughly where it was:
      // the average of the curve becomes the new rate.
      store.setClipSpeed(clip.id, averageSpeed(clip))
      return
    }
    if (curved) return
    // A flat curve over the whole stretch of source.
    store.setClipSpeedCurve(clip.id, [
      { t: sourceStart, value: clip.speed },
      { t: sourceStart + sourceLength, value: clip.speed }
    ])
  }

  const applyPreset = (preset: string): void => {
    const s0 = sourceStart
    const s1 = sourceStart + sourceLength
    const middle = s0 + sourceLength / 2
    const presets: Record<string, SpeedKeyframe[]> = {
      uniform: [
        { t: s0, value: 1 },
        { t: s1, value: 1 }
      ],
      rampUp: [
        { t: s0, value: 1 },
        { t: s1, value: 2 }
      ],
      rampDown: [
        { t: s0, value: 2 },
        { t: s1, value: 1 }
      ],
      slow: [
        { t: s0, value: 0.5 },
        { t: s1, value: 0.5 }
      ],
      montage: [
        { t: s0, value: 2 },
        { t: middle, value: 0.5 },
        { t: s1, value: 2 }
      ]
    }
    const keys = presets[preset]
    if (!keys) return
    useEditor.getState().setClipSpeedCurve(clip.id, keys)
  }

  return (
    <>
      <section className="inspector__section">
        <div className="segmented" role="tablist" aria-label="变速方式">
          <button
            role="tab"
            aria-selected={!curved}
            className={`segmented__item${!curved ? ' is-active' : ''}`}
            onClick={() => switchMode('constant')}
          >
            常规变速
          </button>
          <button
            role="tab"
            aria-selected={curved}
            className={`segmented__item${curved ? ' is-active' : ''}`}
            onClick={() => switchMode('curve')}
          >
            曲线变速
          </button>
        </div>
      </section>

      {curved ? (
        <section className="inspector__section">
          <h3 className="panel-title">速度曲线</h3>
          <SpeedCurveEditor clip={clip} />
          <div className="chip-row">
            <button className="chip" onClick={() => applyPreset('uniform')}>
              匀速
            </button>
            <button className="chip" onClick={() => applyPreset('rampUp')}>
              渐快
            </button>
            <button className="chip" onClick={() => applyPreset('rampDown')}>
              渐慢
            </button>
            <button className="chip" onClick={() => applyPreset('slow')}>
              慢动作
            </button>
            <button className="chip" onClick={() => applyPreset('montage')}>
              蒙太奇
            </button>
          </div>
          <dl className="stat-list">
            <div className="stat-list__row">
              <dt>平均速度</dt>
              <dd className="mono">{averageSpeed(clip).toFixed(2)}×</dd>
            </div>
            <div className="stat-list__row">
              <dt>片段时长</dt>
              <dd className="mono">{formatDuration(clip.duration)}</dd>
            </div>
          </dl>
        </section>
      ) : (
        <section className="inspector__section">
          <h3 className="panel-title">播放速度</h3>
          <PropertyRow
            label="速度"
            clip={clip}
            value={clip.speed}
            min={MIN_SPEED}
            max={MAX_SPEED}
            step={0.05}
            unit="×"
            onChange={(v, options) =>
              useEditor.getState().setClipSpeed(clip.id, v, options)
            }
          />
          <div className="chip-row">
            {[0.25, 0.5, 1, 2, 4].map((rate) => (
              <button
                key={rate}
                className={`chip${Math.abs(clip.speed - rate) < 0.01 ? ' is-active' : ''}`}
                onClick={() => useEditor.getState().setClipSpeed(clip.id, rate)}
              >
                {rate}×
              </button>
            ))}
          </div>
          <dl className="stat-list">
            <div className="stat-list__row">
              <dt>片段时长</dt>
              <dd className="mono">{formatDuration(clip.duration)}</dd>
            </div>
          </dl>
        </section>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

function AudioSection({ clip }: { clip: Clip }): React.JSX.Element {
  const asset = useEditor((s) => s.project.assets[clip.assetId])
  const noAudio = asset && !asset.hasAudio
  const [fadeIn, setFadeIn] = useState(0.5)
  const [fadeOut, setFadeOut] = useState(0.5)
  const animated = clip.keyframes.volume.length > 0

  return (
    <>
      <section className="inspector__section">
        <h3 className="panel-title">音量</h3>
        {noAudio ? (
          <p className="inspector__note">该素材没有音频轨道</p>
        ) : (
          <PropertyRow
            label="音量"
            property="volume"
            clip={clip}
            value={clip.volume}
            min={0}
            max={2}
            step={0.01}
            unitScale={100}
            unit="%"
            onChange={(v, options) =>
              useEditor.getState().setClipProperty(clip.id, 'volume', v, options)
            }
          />
        )}
        <div className="inspector__row">
          <span className="inspector__label">静音</span>
          <button
            className={`toggle${clip.muted ? ' is-on' : ''}`}
            onClick={() => useEditor.getState().toggleClipMute(clip.id)}
            role="switch"
            aria-checked={clip.muted}
          >
            <span className="toggle__knob" />
          </button>
        </div>
      </section>

      {!noAudio ? (
        <section className="inspector__section">
          <h3 className="panel-title">淡入淡出</h3>

          <VolumeEnvelope clip={clip} />

          <div className="fade-row">
            <span className="inspector__label">淡入</span>
            <div className="prop__num">
              <input
                className="prop__num-input mono"
                type="number"
                min={0}
                max={Math.max(0, clip.duration)}
                step={0.1}
                value={fadeIn}
                aria-label="淡入时长"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) setFadeIn(Math.max(0, v))
                }}
              />
              <span className="prop__num-unit">秒</span>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              disabled={fadeIn <= 0}
              onClick={() =>
                useEditor.getState().applyVolumeFade(clip.id, 'in', fadeIn)
              }
            >
              淡入
            </button>
          </div>

          <div className="fade-row">
            <span className="inspector__label">淡出</span>
            <div className="prop__num">
              <input
                className="prop__num-input mono"
                type="number"
                min={0}
                max={Math.max(0, clip.duration)}
                step={0.1}
                value={fadeOut}
                aria-label="淡出时长"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) setFadeOut(Math.max(0, v))
                }}
              />
              <span className="prop__num-unit">秒</span>
            </div>
            <button
              className="btn btn--ghost btn--sm"
              disabled={fadeOut <= 0}
              onClick={() =>
                useEditor.getState().applyVolumeFade(clip.id, 'out', fadeOut)
              }
            >
              淡出
            </button>
          </div>

          {animated ? (
            <button
              className="btn btn--ghost btn--sm btn--block"
              onClick={() => useEditor.getState().clearVolumeCurve(clip.id)}
            >
              清除音量曲线
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  )
}

/**
 * A small drawing of the volume over the length of the clip.
 *
 * It shows what the fade ramps look like and where the playhead currently
 * sits on the envelope.
 */
function VolumeEnvelope({ clip }: { clip: Clip }): React.JSX.Element {
  const width = 244
  const height = 46
  const playhead = useEditor((s) => s.playhead)
  const samples = 60

  const points: string[] = []
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * clip.duration
    const value = Math.min(2, evaluateKeyframes(clip.keyframes.volume, t, clip.volume))
    const x = (i / samples) * width
    const y = height - 5 - (value / 2) * (height - 12)
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  }

  const cursor =
    clip.duration > 0
      ? Math.min(width, Math.max(0, ((playhead - clip.start) / clip.duration) * width))
      : 0

  return (
    <svg
      className="envelope"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      role="img"
      aria-label="音量曲线"
    >
      <line
        className="envelope__base"
        x1={0}
        x2={width}
        y1={height - 5 - (height - 12) / 2}
        y2={height - 5 - (height - 12) / 2}
      />
      <polyline className="envelope__line" points={points.join(' ')} />
      <line className="envelope__cursor" x1={cursor} x2={cursor} y1={0} y2={height} />
    </svg>
  )
}
