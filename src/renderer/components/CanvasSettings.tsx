import { useEffect, useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { canvasSizeFor } from '@/engine/timeline'

/** The sizes the canvas is offered in. */
const RATIOS: { label: string; width: number; height: number }[] = [
  { label: '16:9', width: 1920, height: 1080 },
  { label: '9:16', width: 1080, height: 1920 },
  { label: '1:1', width: 1080, height: 1080 },
  { label: '4:3', width: 1440, height: 1080 },
  { label: '3:4', width: 1080, height: 1440 }
]

const FRAMES = [24, 25, 30, 60]

/**
 * The size of the canvas.
 *
 * The size follows the first material that is imported, until it is set by
 * hand — the button in the title bar shows the current size and opens this
 * panel.
 */
export function CanvasSettings(): React.JSX.Element {
  const settings = useEditor((s) => s.project.settings)
  const assets = useEditor((s) => s.project.assets)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // The panel closes when the pointer goes somewhere else.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const set = (patch: {
    width?: number
    height?: number
    fps?: number
    manual?: boolean
  }): void => {
    useEditor.getState().setProjectSettings(patch)
  }

  const setSize = (width: number, height: number): void => {
    set({ width: evenAtLeast(width, 16), height: evenAtLeast(height, 16) })
  }

  /** Puts the canvas back to the shape of the first material. */
  const followMaterial = (): void => {
    const first = Object.values(assets)[0]
    const size = first ? canvasSizeFor(first) : null
    if (!size) return
    set({ width: size.width, height: size.height, manual: false })
  }

  const first = Object.values(assets)[0]
  const materialSize = first ? canvasSizeFor(first) : null

  return (
    <div className="canvas-menu-root" ref={rootRef}>
      <button
        className="btn btn--ghost btn--sm"
        onClick={() => setOpen((v) => !v)}
        title="画布大小"
        aria-expanded={open}
      >
        {settings.width}×{settings.height}
      </button>

      {open ? (
        <div className="canvas-menu" role="dialog" aria-label="画布大小">
          <div className="canvas-menu__row">
            <div className="prop__num">
              <input
                className="prop__num-input mono"
                type="number"
                min={16}
                max={7680}
                step={2}
                value={settings.width}
                aria-label="画布宽度"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) setSize(v, settings.height)
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
                value={settings.height}
                aria-label="画布高度"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (Number.isFinite(v)) setSize(settings.width, v)
                }}
              />
              <span className="prop__num-unit">高</span>
            </div>
          </div>

          <div className="canvas-menu__label">比例</div>
          <div className="chip-row">
            {RATIOS.map((ratio) => (
              <button
                key={ratio.label}
                className={`chip${
                  settings.width === ratio.width && settings.height === ratio.height
                    ? ' is-active'
                    : ''
                }`}
                onClick={() => setSize(ratio.width, ratio.height)}
              >
                {ratio.label}
              </button>
            ))}
          </div>

          <div className="canvas-menu__label">帧率</div>
          <div className="chip-row">
            {FRAMES.map((fps) => (
              <button
                key={fps}
                className={`chip${settings.fps === fps ? ' is-active' : ''}`}
                onClick={() => set({ fps })}
              >
                {fps}
              </button>
            ))}
          </div>

          {materialSize ? (
            <button
              className="btn btn--ghost btn--sm btn--block canvas-menu__follow"
              onClick={followMaterial}
              title={`跟随素材：${materialSize.width}×${materialSize.height}`}
            >
              跟随素材
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function evenAtLeast(value: number, min: number): number {
  const v = Math.max(min, Math.round(value))
  return v % 2 === 0 ? v : v - 1
}
