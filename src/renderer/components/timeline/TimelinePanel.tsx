import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Asset, AssetKind, Clip, Project, Track, TrackKind } from '@shared/types'
import {
  averageSpeed,
  clipSourceEnd,
  hasSpeedCurve,
  outputDuration,
  sourceAtOffset
} from '@shared/speed'
import { useEditor } from '@/state/store'
import { mediaCache } from '@/state/mediaCache'
import { api } from '@/bridge'
import {
  clipEnd,
  findFreeSlot,
  maxZoomFor,
  MIN_ZOOM,
  occupiedSpans,
  projectDuration,
  spacerWidth,
  sliderToZoom,
  zoomToSlider
} from '@/engine/timeline'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import {
  TL,
  drawDynamic,
  drawStatic,
  formatTimecode,
  timeToX,
  xToTime,
  type DragPreview
} from '@/engine/timelineDraw'

interface HitResult {
  kind: 'ruler' | 'clip' | 'empty'
  clip?: Clip
  clipId?: string
  trackIndex?: number
  edge?: 'start' | 'end'
}

/** Everything the canvas needs to paint a frame. */
interface TimelineView {
  pxPerSecond: number
  project: Project
  selected: Set<string>
  images: Map<string, HTMLImageElement>
  showWaveforms: boolean
  playhead: number
}

/** What the right-click menu is currently opened on. */
type MenuTarget =
  | { kind: 'clip'; x: number; y: number; clipId: string }
  | { kind: 'track'; x: number; y: number; trackId: string }
  | { kind: 'timeline'; x: number; y: number }

type DragMode =
  | { type: 'none' }
  | {
      type: 'move'
      clipId: string
      grabOffset: number
      duration: number
      /** The kind of the track the clip came from — it may only be dropped
       *  on a track of the same kind. */
      kind: TrackKind
      /** A still picture may also be dropped on a video track, because that
       *  is the only place where it can be seen. */
      assetKind: AssetKind
      /** Index of the track the clip came from. */
      originTrack: number
    }
  | {
      type: 'trim-start'
      clipId: string
      originStart: number
      originDuration: number
      originInPoint: number
      speed: number
      /** The head may not reach past this — the neighbour is in the way. */
      minStart: number
    }
  | {
      type: 'trim-end'
      clipId: string
      originStart: number
      originDuration: number
      maxDuration: number
    }
  | { type: 'scrub' }
  | { type: 'marquee'; x0: number; y0: number }

export function TimelinePanel(): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const selectedIds = useEditor((s) => s.selectedClipIds)
  const playhead = useEditor((s) => s.playhead)
  const pxPerSecond = useEditor((s) => s.pxPerSecond)
  const snapEnabled = useEditor((s) => s.snapEnabled)
  const showWaveforms = useEditor((s) => s.showWaveforms)
  const playing = useEditor((s) => s.playing)
  // While a separation is running the menu must not offer another one.
  const vocalBusy = useEditor((s) => s.vocalState.status === 'running')

  // Which engine will do the separation: a model from the separation
  // service when there is one, the built-in filter otherwise.
  const [vocalHint, setVocalHint] = useState('')
  useEffect(() => {
    let cancelled = false
    void api.vocal
      .providers()
      .then((list) => {
        if (cancelled) return
        const chosen =
          list.find((p) => p.kind === 'model' && p.available) ??
          list.find((p) => p.available)
        if (chosen) setVocalHint(chosen.label.split(/[（\s]/)[0].trim())
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const headListRef = useRef<HTMLDivElement>(null)
  const staticRef = useRef<HTMLCanvasElement>(null)
  const dynRef = useRef<HTMLCanvasElement>(null)

  const mediaVersion = useSyncExternalStore(
    mediaCache.subscribe,
    mediaCache.getVersion,
    mediaCache.getVersion
  )

  const dragRef = useRef<DragMode>({ type: 'none' })
  const dragPreviewRef = useRef<DragPreview | null>(null)
  const marqueeRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const snapGuideRef = useRef<number | null>(null)
  const scrollRef = useRef({ x: 0, y: 0 })
  const sizeRef = useRef({ w: 0, h: 0 })
  const staticDirtyRef = useRef(true)

  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  /* ---------------------------------------------------------------- */
  /* Media: thumbnails and waveforms                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    for (const asset of Object.values(project.assets)) {
      mediaCache.ensure(asset)
    }
  }, [project.assets])

  /* ---------------------------------------------------------------- */
  /* Working project with media attached                               */
  /* ---------------------------------------------------------------- */

  const workingProject = useMemo(() => {
    const assets: Record<string, Asset> = { ...project.assets }
    let changed = false
    for (const [id, asset] of Object.entries(assets)) {
      const sprite = mediaCache.sprite(id)
      const waveform = mediaCache.waveform(id)
      if (asset.sprite !== sprite || asset.waveform !== waveform) {
        assets[id] = { ...asset, sprite, waveform }
        changed = true
      }
    }
    return changed ? { ...project, assets } : project
    // mediaVersion forces a recompute when the cache is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, mediaVersion])

  /** The decoded sprite images referenced by the current assets. */
  const images = useMemo(() => {
    const map = new Map<string, HTMLImageElement>()
    for (const asset of Object.values(workingProject.assets)) {
      if (!asset.sprite) continue
      const img = mediaCache.image(asset.sprite.url)
      if (img) map.set(asset.sprite.url, img)
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingProject, mediaVersion])

  /**
   * Everything the canvas needs to paint, kept in a ref.
   *
   * The static layer carries the selection outline, the filmstrips and the
   * waveforms, so it has to be repainted whenever any of *those* change — not
   * only when the document itself does. Without the selection and the zoom in
   * the list, clicking a clip would leave no visible mark until the next
   * document edit, and zooming would leave the thumbnails at the old scale.
   *
   * The render loop reads the values from here instead of closing over them.
   * That matters while the preview is playing: the playhead changes on every
   * frame, and a loop that was torn down and rebuilt on every change would
   * have its next frame cancelled before it ever ran — the timeline would
   * then only wake up once the playback stopped.
   */
  const viewRef = useRef<TimelineView>({
    pxPerSecond,
    project: workingProject,
    selected,
    images,
    showWaveforms,
    playhead
  })
  viewRef.current = {
    pxPerSecond,
    project: workingProject,
    selected,
    images,
    showWaveforms,
    playhead
  }

  /** The view the static layer was painted with the last time. */
  const drawnRef = useRef<TimelineView | null>(null)

  /* ---------------------------------------------------------------- */
  /* Canvas sizing                                                     */
  /* ---------------------------------------------------------------- */

  const resize = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const dpr = window.devicePixelRatio || 1
    const w = scroller.clientWidth
    const h = scroller.clientHeight
    if (w === 0 || h === 0) return
    sizeRef.current = { w, h }
    for (const canvas of [staticRef.current, dynRef.current]) {
      if (!canvas) continue
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
    }
    staticDirtyRef.current = true
  }, [])

  useEffect(() => {
    resize()
    const ro = new ResizeObserver(resize)
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [resize])

  /* ---------------------------------------------------------------- */
  /* Render loop                                                       */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let raf = 0
    const frame = (): void => {
      const { w, h } = sizeRef.current
      if (w > 0 && h > 0) {
        const dpr = window.devicePixelRatio || 1
        const view = viewRef.current

        // The static layer is repainted when the document, the selection, the
        // zoom or the thumbnails changed, and whenever a scroll moved the
        // ground under it.
        const drawn = drawnRef.current
        const stale =
          drawn === null ||
          drawn.pxPerSecond !== view.pxPerSecond ||
          drawn.project !== view.project ||
          drawn.selected !== view.selected ||
          drawn.images !== view.images ||
          drawn.showWaveforms !== view.showWaveforms

        if (staticDirtyRef.current || stale) {
          staticDirtyRef.current = false
          drawnRef.current = view
          const ctx = staticRef.current?.getContext('2d')
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            drawStatic({
              ctx,
              width: w,
              height: h,
              scrollX: scrollRef.current.x,
              scrollY: scrollRef.current.y,
              pxPerSecond: view.pxPerSecond,
              project: view.project,
              selected: view.selected,
              images: view.images,
              showWaveforms: view.showWaveforms
            })
          }
        }

        const dynCtx = dynRef.current?.getContext('2d')
        if (dynCtx) {
          dynCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
          drawDynamic({
            ctx: dynCtx,
            width: w,
            height: h,
            scrollX: scrollRef.current.x,
            scrollY: scrollRef.current.y,
            pxPerSecond: view.pxPerSecond,
            project: view.project,
            playhead: view.playhead,
            selected: view.selected,
            drag: dragPreviewRef.current,
            marquee: marqueeRef.current,
            snapGuide: snapGuideRef.current,
            hoveredId: null
          })
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // The loop reads its values from `viewRef` — it must survive every
    // change of the document and of the playhead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------------------------------------------------------- */
  /* Scrolling                                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const duration = projectDuration(project)
    const spacer = scroller.firstElementChild as HTMLElement | null
    if (!spacer) return
    spacer.style.width = `${Math.max(
      scroller.clientWidth,
      spacerWidth(duration, pxPerSecond)
    )}px`
    spacer.style.height = `${TL.rulerH + project.tracks.length * TL.trackH + 18}px`
  }, [project, pxPerSecond])

  // Keep the playhead in view during playback.
  useEffect(() => {
    if (!playing) return
    const scroller = scrollerRef.current
    if (!scroller) return
    const x = timeToX(playhead, pxPerSecond, scrollRef.current.x)
    const margin = 80
    if (x > scroller.clientWidth - margin) {
      scroller.scrollLeft += x - (scroller.clientWidth - margin)
    } else if (x < 0) {
      scroller.scrollLeft += x
    }
  }, [playhead, playing, pxPerSecond])

  /* ---------------------------------------------------------------- */
  /* Hit testing and snapping                                           */
  /* ---------------------------------------------------------------- */

  const hitTest = useCallback(
    (x: number, y: number): HitResult => {
      if (y < TL.rulerH) return { kind: 'ruler' }

      const trackIndex = Math.floor((y - TL.rulerH + scrollRef.current.y) / TL.trackH)
      const track = project.tracks[trackIndex]
      if (!track) return { kind: 'empty' }

      for (const clip of track.clips) {
        const start = timeToX(clip.start, pxPerSecond, scrollRef.current.x)
        const end = start + clip.duration * pxPerSecond
        if (x >= start - 2 && x <= end + 2) {
          let edge: 'start' | 'end' | undefined
          if (x - start <= TL.edgeGrab) edge = 'start'
          else if (end - x <= TL.edgeGrab) edge = 'end'
          return { kind: 'clip', clip, clipId: clip.id, trackIndex, edge }
        }
      }
      return { kind: 'empty', trackIndex }
    },
    [project, pxPerSecond]
  )

  const applySnap = useCallback(
    (time: number, excludeIds: Set<string>): { value: number; guide: number | null } => {
      if (!snapEnabled) return { value: time, guide: null }
      const threshold = 8 / pxPerSecond
      let best: number | null = null
      let bestDist = Infinity

      const candidates: number[] = [0]
      for (const track of project.tracks) {
        for (const clip of track.clips) {
          if (excludeIds.has(clip.id)) continue
          candidates.push(clip.start, clipEnd(clip))
        }
      }
      const playhead = useEditor.getState().playhead
      candidates.push(playhead)

      for (const c of candidates) {
        const d = Math.abs(c - time)
        if (d < bestDist && d <= threshold) {
          best = c
          bestDist = d
        }
      }
      return best === null ? { value: time, guide: null } : { value: best, guide: best }
    },
    [snapEnabled, pxPerSecond, project]
  )

  /* ---------------------------------------------------------------- */
  /* Pointer interaction                                               */
  /* ---------------------------------------------------------------- */

  const attachPointerHandlers = useCallback((): void => {
    const onMove = (ev: PointerEvent): void => {
      const canvas = dynRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const y = ev.clientY - rect.top
      const mode = dragRef.current
      const state = useEditor.getState()

      if (mode.type === 'scrub') {
        state.setPlayhead(Math.max(0, xToTime(x, pxPerSecond, scrollRef.current.x)))
        return
      }

      if (mode.type === 'marquee') {
        marqueeRef.current = { x0: mode.x0, y0: mode.y0, x1: x, y1: y }
        return
      }

      if (mode.type === 'move') {
        const raw = xToTime(x, pxPerSecond, scrollRef.current.x) - mode.grabOffset
        const snapped = applySnap(raw, new Set([mode.clipId]))
        // The clip may only travel between tracks of its own kind — a video
        // stays on a video track, an audio clip on an audio track. Hovering
        // an incompatible lane leaves the clip on the lane it came from.
        const hovered = Math.floor((y - TL.rulerH + scrollRef.current.y) / TL.trackH)
        const hoveredTrack = state.project.tracks[hovered]
        // A picture may also travel onto a video track — that is the only
        // place where it can be seen.
        const fits =
          hoveredTrack &&
          (hoveredTrack.kind === mode.kind ||
            (mode.assetKind === 'image' && hoveredTrack.kind === 'video'))
        const trackIndex = fits ? hovered : mode.originTrack
        // Two clips never share a stretch of a lane, so the clip lands in the
        // free place closest to where it was dropped. The preview shows the
        // place it will really take.
        const target = state.project.tracks[trackIndex]
        const at = target
          ? findFreeSlot(
              occupiedSpans(target, new Set([mode.clipId])),
              snapped.value,
              mode.duration
            )
          : Math.max(0, snapped.value)
        dragPreviewRef.current = {
          kind: 'move',
          clipId: mode.clipId,
          start: Math.max(0, at),
          duration: mode.duration,
          trackIndex
        }
        // The guide only helps when the clip really landed on the snap.
        snapGuideRef.current = Math.abs(at - snapped.value) < 1e-6 ? snapped.guide : null
        return
      }

      if (mode.type === 'trim-start') {
        const snapped = applySnap(xToTime(x, pxPerSecond, scrollRef.current.x), new Set([mode.clipId]))
        const maxStart = mode.originStart + mode.originDuration - 0.05
        const start = Math.max(mode.minStart, Math.min(maxStart, snapped.value))
        dragPreviewRef.current = {
          kind: 'trim-start',
          clipId: mode.clipId,
          start,
          duration: mode.originDuration - (start - mode.originStart),
          trackIndex: trackIndexOfClip(state.project, mode.clipId)
        }
        snapGuideRef.current = snapped.guide
        return
      }

      if (mode.type === 'trim-end') {
        const raw = mode.originStart + (xToTime(x, pxPerSecond, scrollRef.current.x) - mode.originStart)
        const snapped = applySnap(raw, new Set([mode.clipId]))
        const duration = Math.max(
          0.05,
          Math.min(mode.maxDuration, snapped.value - mode.originStart)
        )
        dragPreviewRef.current = {
          kind: 'trim-end',
          clipId: mode.clipId,
          start: mode.originStart,
          duration,
          trackIndex: trackIndexOfClip(state.project, mode.clipId)
        }
        snapGuideRef.current = snapped.guide
      }
    }

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const mode = dragRef.current
      const preview = dragPreviewRef.current
      const marquee = marqueeRef.current
      dragRef.current = { type: 'none' }
      dragPreviewRef.current = null
      marqueeRef.current = null
      snapGuideRef.current = null

      const state = useEditor.getState()

      if (mode.type === 'marquee' && marquee) {
        const x0 = Math.min(marquee.x0, marquee.x1)
        const x1 = Math.max(marquee.x0, marquee.x1)
        const y0 = Math.min(marquee.y0, marquee.y1)
        const y1 = Math.max(marquee.y0, marquee.y1)
        if (x1 - x0 > 3 && y1 - y0 > 3) {
          const t0 = xToTime(x0, pxPerSecond, scrollRef.current.x)
          const t1 = xToTime(x1, pxPerSecond, scrollRef.current.x)
          const ids: string[] = []
          state.project.tracks.forEach((track, index) => {
            const top = TL.rulerH + index * TL.trackH - scrollRef.current.y
            if (y1 < top || y0 > top + TL.trackH) return
            for (const clip of track.clips) {
              if (clip.start < t1 && clipEnd(clip) > t0) ids.push(clip.id)
            }
          })
          state.select(ids)
        }
        return
      }

      if (mode.type === 'move' && preview) {
        const original = state.project.tracks
          .flatMap((t) => t.clips)
          .find((c) => c.id === preview.clipId)
        const target = state.project.tracks[preview.trackIndex]
        if (!original || !target) return
        const changed =
          Math.abs(preview.start - original.start) > 1e-6 ||
          target.id !== (state.project.tracks[mode.originTrack]?.id ?? original.trackId)
        if (!changed) return
        // One action: the clip changes track and position together.
        state.moveClip(preview.clipId, target.id, preview.start)
        return
      }

      if ((mode.type === 'trim-start' || mode.type === 'trim-end') && preview) {
        state.mutate((draft) => {
          for (const track of draft.tracks) {
            const clip = track.clips.find((c) => c.id === preview.clipId)
            if (!clip) continue
            if (mode.type === 'trim-start') {
              const delta = preview.start - mode.originStart
              clip.start = preview.start
              clip.duration = preview.duration
              if (hasSpeedCurve(clip)) {
                // The new head of the clip is the source it used to show
                // at that point of the timeline. The curve is anchored to
                // the source, so it is simply cut along with the clip.
                const sourceEnd = clipSourceEnd(clip)
                const head = sourceAtOffset(clip, delta)
                clip.inPoint = Math.max(0, head)
                clip.sourceDuration = Math.max(0, sourceEnd - clip.inPoint)
                clip.duration = outputDuration(clip)
                clip.speed = averageSpeed(clip)
              } else {
                clip.inPoint = Math.max(0, mode.originInPoint + delta * mode.speed)
              }
            } else {
              clip.duration = preview.duration
              if (hasSpeedCurve(clip)) {
                // The tail of the source that is still shown.
                const sourceEnd = sourceAtOffset(clip, preview.duration)
                clip.sourceDuration = Math.max(0, sourceEnd - clip.inPoint)
                clip.duration = outputDuration(clip)
                clip.speed = averageSpeed(clip)
              }
              // The length is worked out again for a clip with a curve, so
              // the tail is measured once more: it may not reach into the
              // clip that follows.
              const limit = nextClipStart(track.clips, clip)
              if (Number.isFinite(limit)) {
                clip.duration = Math.min(clip.duration, limit - clip.start)
              }
            }
          }
        })
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [applySnap, pxPerSecond])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const canvas = dynRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const state = useEditor.getState()

      // Middle button pans the timeline.
      if (e.button === 1) {
        const scroller = scrollerRef.current
        if (!scroller) return
        e.preventDefault()
        const startX = e.clientX
        const startY = e.clientY
        const startLeft = scroller.scrollLeft
        const startTop = scroller.scrollTop
        const onMove = (ev: PointerEvent): void => {
          scroller.scrollLeft = startLeft - (ev.clientX - startX)
          scroller.scrollTop = startTop - (ev.clientY - startY)
        }
        const onUp = (): void => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        return
      }

      const hit = hitTest(x, y)

      if (hit.kind === 'ruler') {
        dragRef.current = { type: 'scrub' }
        state.setPlayhead(Math.max(0, xToTime(x, pxPerSecond, scrollRef.current.x)))
        attachPointerHandlers()
        return
      }

      if (hit.kind === 'clip' && hit.clip && hit.clipId) {
        const clip = hit.clip
        if (e.shiftKey) {
          state.toggleSelect(clip.id, true)
        } else if (!state.selectedClipIds.includes(clip.id)) {
          state.select([clip.id])
        }

        const track = state.project.tracks[hit.trackIndex ?? 0]
        // A locked track keeps its clips where they are: the clip is still
        // selectable, but it cannot be dragged or trimmed.
        if (track?.locked) return

        // History is pushed when the drag is committed, not here — a click
        // that moves nothing should not leave an empty undo step behind.
        const asset = state.project.assets[clip.assetId]
        const assetDuration = asset
          ? hasSpeedCurve(clip)
            ? outputDuration({ ...clip, sourceDuration: asset.duration - clip.inPoint })
            : (asset.duration - clip.inPoint) / (clip.speed || 1)
          : clip.duration

        // The clip may not grow into its neighbours: the head stops where
        // the clip before it ends, the tail where the clip after it starts.
        let prevEnd = 0
        let nextStart = Infinity
        for (const other of track?.clips ?? []) {
          if (other.id === clip.id) continue
          if (other.start < clip.start) {
            prevEnd = Math.max(prevEnd, other.start + other.duration)
          } else {
            nextStart = Math.min(nextStart, other.start)
          }
        }
        const maxDuration = Math.min(assetDuration, nextStart - clip.start)

        if (hit.edge === 'start') {
          // The head can only reach back as far as the material in front of
          // it goes — there is nothing to show beyond that.
          const sourceRoom = clip.inPoint / (clip.speed || 1)
          dragRef.current = {
            type: 'trim-start',
            clipId: clip.id,
            originStart: clip.start,
            originDuration: clip.duration,
            originInPoint: clip.inPoint,
            speed: clip.speed,
            minStart: Math.max(0, prevEnd, clip.start - sourceRoom)
          }
        } else if (hit.edge === 'end') {
          dragRef.current = {
            type: 'trim-end',
            clipId: clip.id,
            originStart: clip.start,
            originDuration: clip.duration,
            maxDuration
          }
        } else {
          dragRef.current = {
            type: 'move',
            clipId: clip.id,
            grabOffset: xToTime(x, pxPerSecond, scrollRef.current.x) - clip.start,
            duration: clip.duration,
            kind: track?.kind ?? 'video',
            assetKind: asset?.kind ?? 'video',
            originTrack: hit.trackIndex ?? 0
          }
        }
        attachPointerHandlers()
        return
      }

      // Empty space starts a marquee selection.
      if (!e.shiftKey) state.clearSelection()
      dragRef.current = { type: 'marquee', x0: x, y0: y }
      marqueeRef.current = { x0: x, y0: y, x1: x, y1: y }
      attachPointerHandlers()
    },
    [hitTest, pxPerSecond, attachPointerHandlers]
  )

  const onWheel = useCallback((e: React.WheelEvent) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const rect = dynRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const state = useEditor.getState()
      const oldPx = state.pxPerSecond
      const factor = Math.exp(-e.deltaY * 0.0035)
      // The zoom runs from "the whole project in one screen" to "as fine as
      // the project can carry" — the upper end follows the length of the
      // timeline so that the end of it stays reachable.
      const maxPx = maxZoomFor(projectDuration(state.project))
      const newPx = Math.min(maxPx, Math.max(MIN_ZOOM, oldPx * factor))
      const timeAtCursor = xToTime(x, oldPx, scroller.scrollLeft)
      state.setZoom(newPx)
      requestAnimationFrame(() => {
        scroller.scrollLeft = timeAtCursor * newPx - x
      })
      return
    }
    if (Math.abs(e.deltaX) > 0) {
      scroller.scrollLeft += e.deltaX
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Right-click menus                                                 */
  /* ---------------------------------------------------------------- */

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const rect = dynRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const hit = hitTest(x, y)
      const state = useEditor.getState()

      if (hit.kind === 'clip' && hit.clipId) {
        // Right-clicking a clip selects it, the way every editor behaves.
        if (!state.selectedClipIds.includes(hit.clipId)) state.select([hit.clipId])
        setMenu({ kind: 'clip', x: e.clientX, y: e.clientY, clipId: hit.clipId })
        return
      }
      setMenu({ kind: 'timeline', x: e.clientX, y: e.clientY })
    },
    [hitTest]
  )

  const onTrackContextMenu = useCallback((e: React.MouseEvent, trackId: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ kind: 'track', x: e.clientX, y: e.clientY, trackId })
  }, [])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const store = useEditor.getState()

    if (menu.kind === 'clip') {
      const clip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === menu.clipId)
      if (!clip) return []
      const trackIndex = project.tracks.findIndex((t) => t.clips.some((c) => c.id === clip.id))
      const track = project.tracks[trackIndex]
      const locked = !!track?.locked
      const local = playhead - clip.start
      const canSplit = local > 0.001 && local < clip.duration - 0.001
      // The sound can only be lifted out of a clip that still carries it.
      const asset = project.assets[clip.assetId]
      const canSeparateAudio = !!(
        track?.kind === 'video' &&
        asset?.hasAudio &&
        !clip.muted
      )

      // The clip may be moved to a neighbouring track of the same kind.
      const siblings = project.tracks.filter((t) => t.kind === track?.kind)
      const pos = siblings.findIndex((t) => t.id === track?.id)
      const prev = pos > 0 ? siblings[pos - 1] : null
      const next = pos >= 0 && pos < siblings.length - 1 ? siblings[pos + 1] : null

      return [
        {
          id: 'split',
          label: '在播放头处分割',
          hint: 'S',
          disabled: !canSplit || locked,
          onSelect: () => store.splitClipAt(clip.id, playhead)
        },
        {
          id: 'duplicate',
          label: '复制片段',
          hint: 'Ctrl+D',
          disabled: locked,
          onSelect: () => {
            store.select([clip.id])
            store.duplicateSelected()
          }
        },
        {
          id: 'delete',
          label: '删除片段',
          hint: 'Del',
          danger: true,
          disabled: locked,
          onSelect: () => {
            store.select([clip.id])
            store.deleteSelected()
          }
        },
        { id: 'sep-1', separator: true },
        {
          id: 'mute',
          label: clip.muted ? '取消静音' : '静音',
          disabled: locked,
          onSelect: () => store.toggleClipMute(clip.id)
        },
        track?.kind === 'audio'
          ? {
              id: 'reset-volume',
              label: '重置音量',
              disabled: locked,
              onSelect: () =>
                store.setClipProperty(clip.id, 'volume', 1)
            }
          : {
              id: 'reset',
              label: '重置变换',
              disabled: locked,
              onSelect: () => store.resetClipTransform(clip.id)
            },
        ...(track?.kind === 'audio'
          ? []
          : [
              {
                id: 'reset-adjustments',
                label: '重置调整',
                disabled: locked,
                onSelect: () => store.resetClipAdjustments(clip.id)
              }
            ]),
        {
          id: 'separate-audio',
          label: '分离音频',
          disabled: locked || !canSeparateAudio,
          onSelect: () => store.separateClipAudio(clip.id)
        },
        {
          id: 'separate-vocals',
          label: '人声分离',
          hint: vocalHint || undefined,
          disabled: locked || !canSeparateAudio || vocalBusy,
          onSelect: () => {
            void store.separateClipVocals(clip.id)
          }
        },
        { id: 'sep-2', separator: true },
        {
          id: 'speed-05',
          label: '速度 0.5×',
          disabled: locked,
          onSelect: () => store.setClipSpeed(clip.id, 0.5)
        },
        {
          id: 'speed-1',
          label: '速度 1×',
          disabled: locked,
          onSelect: () => store.setClipSpeed(clip.id, 1)
        },
        {
          id: 'speed-2',
          label: '速度 2×',
          disabled: locked,
          onSelect: () => store.setClipSpeed(clip.id, 2)
        },
        { id: 'sep-3', separator: true },
        {
          id: 'move-up',
          label: '移到上一轨',
          disabled: !prev || locked,
          onSelect: () => {
            if (prev) store.moveClip(clip.id, prev.id, clip.start)
          }
        },
        {
          id: 'move-down',
          label: '移到下一轨',
          disabled: !next || locked,
          onSelect: () => {
            if (next) store.moveClip(clip.id, next.id, clip.start)
          }
        }
      ]
    }

    if (menu.kind === 'track') {
      const track = project.tracks.find((t) => t.id === menu.trackId)
      if (!track) return []
      const siblings = project.tracks.filter((t) => t.kind === track.kind)
      const pos = siblings.findIndex((t) => t.id === track.id)

      return [
        {
          id: 'rename',
          label: '重命名轨道',
          onSelect: () => setRenamingId(track.id)
        },
        {
          id: 'hidden',
          label: track.hidden ? '显示轨道' : '隐藏轨道',
          onSelect: () => store.toggleTrackFlag(track.id, 'hidden')
        },
        {
          id: 'muted',
          label: track.muted ? '取消静音' : '静音轨道',
          onSelect: () => store.toggleTrackFlag(track.id, 'muted')
        },
        {
          id: 'locked',
          label: track.locked ? '解锁轨道' : '锁定轨道',
          onSelect: () => store.toggleTrackFlag(track.id, 'locked')
        },
        { id: 'sep-1', separator: true },
        {
          id: 'move-up',
          label: track.kind === 'video' ? '上移一层' : '上移',
          disabled: pos <= 0,
          onSelect: () => store.moveTrack(track.id, -1)
        },
        {
          id: 'move-down',
          label: track.kind === 'video' ? '下移一层' : '下移',
          disabled: pos < 0 || pos >= siblings.length - 1,
          onSelect: () => store.moveTrack(track.id, 1)
        },
        { id: 'sep-2', separator: true },
        {
          id: 'add-video',
          label: '添加视频轨道',
          onSelect: () => store.addTrack('video')
        },
        {
          id: 'add-audio',
          label: '添加音频轨道',
          onSelect: () => store.addTrack('audio')
        },
        { id: 'sep-3', separator: true },
        {
          id: 'delete',
          label: '删除轨道',
          danger: true,
          onSelect: () => store.removeTrack(track.id)
        }
      ]
    }

    return [
      {
        id: 'add-video',
        label: '添加视频轨道',
        onSelect: () => store.addTrack('video')
      },
      {
        id: 'add-audio',
        label: '添加音频轨道',
        onSelect: () => store.addTrack('audio')
      },
      { id: 'sep-1', separator: true },
      {
        id: 'snap',
        label: snapEnabled ? '关闭吸附对齐' : '开启吸附对齐',
        onSelect: () => store.setSnap(!snapEnabled)
      },
      {
        id: 'waveform',
        label: showWaveforms ? '隐藏音频波形' : '显示音频波形',
        onSelect: () => store.setShowWaveforms(!showWaveforms)
      },
      { id: 'sep-2', separator: true },
      {
        id: 'deselect',
        label: '取消选择',
        disabled: selectedIds.length === 0,
        onSelect: () => store.clearSelection()
      }
    ]
  }, [menu, project, playhead, snapEnabled, showWaveforms, selectedIds.length, vocalBusy, vocalHint])

  /* ---------------------------------------------------------------- */
  /* Dropping media from the library                                   */
  /* ---------------------------------------------------------------- */

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const assetId = e.dataTransfer.getData('application/x-clipforge-asset')
      if (!assetId) return
      const rect = dynRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const time = Math.max(0, xToTime(x, pxPerSecond, scrollRef.current.x))
      const state = useEditor.getState()
      const trackIndex = Math.max(
        0,
        Math.min(
          project.tracks.length - 1,
          Math.floor((y - TL.rulerH + scrollRef.current.y) / TL.trackH)
        )
      )
      // History is recorded before anything changes, so a single undo takes
      // the whole drop — including a track created for it — back.
      state.pushHistory()
      let track: Track | undefined = project.tracks[trackIndex]
      if (!track) {
        // Every track was deleted — put the media on a fresh one instead of
        // dropping it on the floor.
        const asset = project.assets[assetId]
        const kind = asset && asset.kind === 'audio' ? 'audio' : 'video'
        const trackId = state.ensureTrack(kind)
        // Read the fresh project — the snapshot taken above predates the
        // track that was just created.
        track = useEditor.getState().project.tracks.find((t) => t.id === trackId)
      }
      if (!track) return
      state.insertClip(assetId, track.id, time)
    },
    [pxPerSecond, project.tracks]
  )

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scrollRef.current = { x: scroller.scrollLeft, y: scroller.scrollTop }
    staticDirtyRef.current = true
    // The track headers live outside the canvas, so they have to follow the
    // timeline's vertical scroll by hand — otherwise they drift away from the
    // lanes they label as soon as there are more tracks than fit.
    const heads = headListRef.current
    if (heads && Math.abs(heads.scrollTop - scroller.scrollTop) > 0.5) {
      heads.scrollTop = scroller.scrollTop
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const duration = projectDuration(project)
  // The zoom reaches as far in as the length of the timeline allows.
  const maxZoom = maxZoomFor(duration)

  return (
    <div className="timeline">
      <div className="timeline__toolbar">
        <div className="timeline__toolbar-group">
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => useEditor.getState().splitAtPlayhead()}
            title="在播放头处分割 (S)"
          >
            分割
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => useEditor.getState().duplicateSelected()}
            title="复制选中的片段 (Ctrl+D)"
          >
            复制
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => useEditor.getState().deleteSelected()}
            title="删除选中的片段 (Delete)"
          >
            删除
          </button>
        </div>

        <div className="timeline__toolbar-group">
          <button
            className={`btn btn--ghost btn--sm${snapEnabled ? ' is-active' : ''}`}
            onClick={() => useEditor.getState().setSnap(!snapEnabled)}
            title="吸附对齐"
          >
            吸附
          </button>
          <button
            className={`btn btn--ghost btn--sm${showWaveforms ? ' is-active' : ''}`}
            onClick={() => useEditor.getState().setShowWaveforms(!showWaveforms)}
            title="显示音频波形"
          >
            波形
          </button>
          <div className="timeline__zoom">
            <button
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => useEditor.getState().setZoom(pxPerSecond / 1.4)}
              title="缩小"
            >
              <MinusIcon />
            </button>
            <input
              className="timeline__zoom-slider"
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={zoomToSlider(pxPerSecond, maxZoom)}
              onChange={(e) =>
                useEditor.getState().setZoom(sliderToZoom(Number(e.target.value), maxZoom))
              }
              aria-label="时间轴缩放"
            />
            <button
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => useEditor.getState().setZoom(pxPerSecond * 1.4)}
              title="放大"
            >
              <PlusIcon />
            </button>
          </div>
        </div>
      </div>

      <div className="timeline__body">
        <TrackHeaders
          listRef={headListRef}
          renamingId={renamingId}
          onRenameStart={setRenamingId}
          onRenameCommit={(trackId, name) => {
            setRenamingId(null)
            useEditor.getState().renameTrack(trackId, name)
          }}
          onContextMenu={onTrackContextMenu}
        />
        <div className="timeline__canvas-wrap" ref={wrapRef}>
          <canvas ref={staticRef} className="timeline__canvas" />
          <canvas ref={dynRef} className="timeline__canvas timeline__canvas--dynamic" />
          <div
            className="timeline__scroller"
            ref={scrollerRef}
            onScroll={onScroll}
            onPointerDown={onPointerDown}
            onWheel={onWheel}
            onContextMenu={onContextMenu}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
          >
            <div className="timeline__spacer" />
          </div>
        </div>
      </div>

      <div className="timeline__status">
        <span className="mono timeline__status-time">
          {formatTimecode(playhead, project.settings.fps)}
        </span>
        <span className="timeline__status-sep">/</span>
        <span className="mono timeline__status-total">
          {formatTimecode(duration, project.settings.fps)}
        </span>
        <span className="timeline__status-hint">拖动片段移动 · 拖动边缘裁剪 · S 分割</span>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}

function trackIndexOfClip(
  project: { tracks: { id: string; clips: { id: string }[] }[] },
  clipId: string
): number {
  return project.tracks.findIndex((t) => t.clips.some((c) => c.id === clipId))
}

/** The place where the clip after this one on the lane begins. */
function nextClipStart(clips: Clip[], clip: Clip): number {
  let next = Infinity
  for (const other of clips) {
    if (other.id === clip.id) continue
    if (other.start < clip.start) continue
    next = Math.min(next, other.start)
  }
  return next
}

interface TrackHeadersProps {
  listRef: React.RefObject<HTMLDivElement | null>
  /** Track whose name is currently being edited, if any. */
  renamingId: string | null
  onRenameStart: (trackId: string) => void
  onRenameCommit: (trackId: string, name: string) => void
  onContextMenu: (e: React.MouseEvent, trackId: string) => void
}

function TrackHeaders({
  listRef,
  renamingId,
  onRenameStart,
  onRenameCommit,
  onContextMenu
}: TrackHeadersProps): React.JSX.Element {
  const project = useEditor((s) => s.project)
  const [draft, setDraft] = useState('')

  // Seed the field with the current name whenever a rename starts.
  useEffect(() => {
    if (!renamingId) return
    const track = project.tracks.find((t) => t.id === renamingId)
    if (track) setDraft(track.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renamingId])

  const commit = (trackId: string, name: string): void => {
    // An empty name would leave the track without a label, so it is ignored.
    if (name.trim()) onRenameCommit(trackId, name)
    else onRenameCommit(trackId, '')
  }

  return (
    <div className="timeline__heads">
      <div className="timeline__head-spacer">
        <span className="label">轨道</span>
        <div className="timeline__head-adds">
          <button
            className="timeline__head-add"
            title="添加视频轨道"
            onClick={() => useEditor.getState().addTrack('video')}
          >
            +视频
          </button>
          <button
            className="timeline__head-add timeline__head-add--audio"
            title="添加音频轨道"
            onClick={() => useEditor.getState().addTrack('audio')}
          >
            +音频
          </button>
        </div>
      </div>
      <div className="timeline__head-list" ref={listRef}>
        {project.tracks.map((track) => (
          <div
            key={track.id}
            className={`track-head track-head--${track.kind}${
              track.locked ? ' is-locked' : ''
            }`}
            onContextMenu={(e) => onContextMenu(e, track.id)}
          >
            <div className="track-head__row">
              {renamingId === track.id ? (
                <input
                  className="track-head__rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commit(track.id, draft)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commit(track.id, draft)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setDraft('')
                      onRenameCommit(track.id, '')
                    }
                  }}
                />
              ) : (
                <span
                  className="track-head__name"
                  title={`${track.name} · 双击重命名`}
                  onDoubleClick={() => onRenameStart(track.id)}
                >
                  {track.name}
                </span>
              )}
              <div className="track-head__buttons">
                <button
                  className={`track-head__btn${track.hidden ? ' is-off' : ''}`}
                  title={track.hidden ? '显示轨道' : '隐藏轨道'}
                  onClick={() => useEditor.getState().toggleTrackFlag(track.id, 'hidden')}
                >
                  <EyeIcon hidden={track.hidden} />
                </button>
                <button
                  className={`track-head__btn${track.muted ? ' is-off' : ''}`}
                  title={track.muted ? '取消静音' : '静音轨道'}
                  onClick={() => useEditor.getState().toggleTrackFlag(track.id, 'muted')}
                >
                  <SpeakerIcon muted={track.muted} />
                </button>
              </div>
            </div>
            <div className="track-head__meta-row">
              <span className="track-head__meta">
                {track.locked
                  ? '已锁定'
                  : track.clips.length > 0
                    ? `${track.clips.length} 个片段`
                    : '空'}
              </span>
              <button
                className="track-head__remove"
                title="删除轨道"
                onClick={() => useEditor.getState().removeTrack(track.id)}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
        ))}
        {/* Matches the tail the timeline canvas reserves below the last
            lane, so both columns scroll over the same range. */}
        <div className="timeline__head-tail" />
      </div>
    </div>
  )
}

function MinusIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 2.5v7M2.5 6h7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function EyeIcon({ hidden }: { hidden: boolean }): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M1.5 7s2.2-3.6 5.5-3.6S12.5 7 12.5 7 10.3 10.6 7 10.6 1.5 7 1.5 7Z"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity={hidden ? 0.4 : 1}
      />
      <circle
        cx="7"
        cy="7"
        r="1.7"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity={hidden ? 0.4 : 1}
      />
    </svg>
  )
}

function SpeakerIcon({ muted }: { muted: boolean }): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 5.2h2L7 3v8L4.5 8.8h-2V5.2Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity={muted ? 0.4 : 1}
      />
      {muted ? (
        <path
          d="M9.5 5.5l3 3M12.5 5.5l-3 3"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M9.4 5.1a2.6 2.6 0 0 1 0 3.8M11.2 3.6a5 5 0 0 1 0 6.8"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.6 4h8.8M5.4 4V2.8h3.2V4M3.6 4l.6 7.2h5.6L10.4 4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
