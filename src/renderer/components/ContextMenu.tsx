import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  id: string
  label?: string
  /** Right-aligned hint, usually a keyboard shortcut. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** A hairline between two groups of items. */
  separator?: boolean
  onSelect?: () => void
}

export interface ContextMenuProps {
  /** Viewport coordinates of the pointer that opened the menu. */
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

/**
 * A small, self-contained menu used by the timeline.
 *
 * It closes on an outside click, on Escape and when the window loses focus,
 * and it keeps itself inside the viewport — a menu that opens off the edge
 * of the screen is unusable.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    let left = x
    let top = y
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin)
    }
    setPos({ left, top })
  }, [x, y, items])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    const onBlur = (): void => onClose()
    // `capture` so the menu closes before the click reaches the timeline.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  const selectable = items.filter((item) => !item.separator && !item.disabled)

  const move = (delta: number): void => {
    if (selectable.length === 0) return
    const current = selectable.findIndex((item) => item.id === items[active]?.id)
    const next = (current + delta + selectable.length) % selectable.length
    setActive(items.indexOf(selectable[next]))
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      const item = items[active]
      if (item && !item.disabled && !item.separator) {
        item.onSelect?.()
        onClose()
      }
    }
  }

  return (
    <div
      className="ctxmenu"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={item.id} className="ctxmenu__sep" role="separator" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            disabled={item.disabled}
            className={`ctxmenu__item${item.danger ? ' is-danger' : ''}${
              index === active ? ' is-active' : ''
            }`}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              if (item.disabled) return
              item.onSelect?.()
              onClose()
            }}
          >
            <span className="ctxmenu__label">{item.label}</span>
            {item.hint ? <span className="ctxmenu__hint mono">{item.hint}</span> : null}
          </button>
        )
      )}
    </div>
  )
}
