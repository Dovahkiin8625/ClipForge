import type { Clip, ClipAdjustments } from '@shared/types'
import { useEditor } from '@/state/store'
import { defaultAdjustments, isNeutral } from '@shared/adjustments'
import { PropertyRow } from '@/components/PropertyRow'

/**
 * The colour panel of the inspector.
 *
 * The adjustments are plain numbers on the clip: the preview filters the
 * picture on the GPU and the export writes the matching FFmpeg filters, so
 * what is on screen is what ends up in the file.
 */
export function AdjustmentsSection({ clip }: { clip: Clip }): React.JSX.Element {
  const asset = useEditor((s) => s.project.assets[clip.assetId])
  const adjustments = clip.adjustments ?? defaultAdjustments()
  const changed = !isNeutral(adjustments)

  if (asset?.kind === 'audio') {
    return (
      <section className="inspector__section">
        <h3 className="panel-title">调整</h3>
        <p className="inspector__note">音频片段没有画面属性</p>
      </section>
    )
  }

  return (
    <>
      <section className="inspector__section">
        <h3 className="panel-title">光线</h3>
        <Row clip={clip} label="亮度" value={adjustments.brightness} onChange={set(clip, 'brightness')} />
        <Row clip={clip} label="对比度" value={adjustments.contrast} onChange={set(clip, 'contrast')} />
        <Row clip={clip} label="高光" value={adjustments.highlights} onChange={set(clip, 'highlights')} />
        <Row clip={clip} label="阴影" value={adjustments.shadows} onChange={set(clip, 'shadows')} />
      </section>

      <section className="inspector__section">
        <h3 className="panel-title">色彩</h3>
        <Row clip={clip} label="饱和度" value={adjustments.saturation} onChange={set(clip, 'saturation')} />
        <Row clip={clip} label="色温" value={adjustments.temperature} onChange={set(clip, 'temperature')} />
      </section>

      <section className="inspector__section">
        <h3 className="panel-title">细节</h3>
        <Row clip={clip} label="锐化" value={adjustments.sharpen} onChange={set(clip, 'sharpen')} min={0} />
        <Row clip={clip} label="模糊" value={adjustments.blur} onChange={set(clip, 'blur')} min={0} />
        <Row clip={clip} label="颗粒" value={adjustments.grain} onChange={set(clip, 'grain')} min={0} />
      </section>

      <section className="inspector__section">
        <div className="chip-row">
          <button
            className="chip"
            onClick={() => applyPreset(clip, { saturation: -1, contrast: 0.1 })}
            title="去掉颜色，只留下明暗"
          >
            黑白
          </button>
          <button
            className="chip"
            onClick={() => applyPreset(clip, { temperature: 0.4, highlights: 0.1 })}
            title="偏暖的色调"
          >
            暖调
          </button>
          <button
            className="chip"
            onClick={() => applyPreset(clip, { temperature: -0.4, shadows: 0.15 })}
            title="偏冷的色调"
          >
            冷调
          </button>
          <button
            className="chip"
            onClick={() => applyPreset(clip, { contrast: 0.2, shadows: -0.15, grain: 0.25 })}
            title="更硬的反差，加上一点颗粒"
          >
            胶片
          </button>
        </div>
        <button
          className="btn btn--ghost btn--sm btn--block"
          disabled={!changed}
          onClick={() => useEditor.getState().resetClipAdjustments(clip.id)}
        >
          重置调整
        </button>
      </section>
    </>
  )
}

/**
 * One adjustment.
 *
 * The clip is handed to the row so that the playhead moves onto it — the
 * adjustments are only visible while the clip is on screen.
 */
function Row({
  clip,
  label,
  value,
  onChange,
  min = -1
}: {
  clip: Clip
  label: string
  value: number
  onChange: (v: number, options?: { silent?: boolean }) => void
  min?: number
}): React.JSX.Element {
  return (
    <PropertyRow
      label={label}
      value={value}
      min={min}
      max={1}
      step={0.01}
      unitScale={100}
      clip={clip}
      onChange={onChange}
    />
  )
}

/** Writes one adjustment of a clip into the document. */
function set(
  clip: Clip,
  key: keyof ClipAdjustments
): (v: number, options?: { silent?: boolean }) => void {
  return (v, options) => {
    useEditor.getState().setClipAdjustments(clip.id, { [key]: v }, options)
  }
}

/** Writes a whole set of adjustments at once. */
function applyPreset(clip: Clip, patch: Partial<ClipAdjustments>): void {
  useEditor.getState().setClipAdjustments(clip.id, patch)
}
