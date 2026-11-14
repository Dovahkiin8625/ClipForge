import { create } from 'zustand'
import { produce } from 'immer'
import type {
  AnimatableProperty,
  Asset,
  Clip,
  ClipAdjustments,
  ExportState,
  ImportedAsset,
  Project,
  ProjectSettings,
  SpeedKeyframe,
  Track,
  TrackKind
} from '@shared/types'
import {
  averageSpeed,
  clampSpeed,
  clipSourceDuration,
  clipSourceEnd,
  hasSpeedCurve,
  outputDuration,
  sourceAtOffset
} from '@shared/speed'
import { defaultAdjustments, normalizeAdjustments } from '@shared/adjustments'
import {
  createProject,
  canvasSizeFor,
  findFreeSlot,
  maxZoomFor,
  MIN_ZOOM,
  nextTrackName,
  occupiedSpans,
  projectDuration,
  pushClipsApart
} from '@/engine/timeline'
import { emptyKeyframes, evaluateKeyframes, setKeyframe } from '@/engine/keyframes'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

const HISTORY_LIMIT = 120

interface EditorState {
  project: Project
  selectedClipIds: string[]
  playhead: number
  playing: boolean
  /** Timeline zoom, in pixels per second. */
  pxPerSecond: number
  snapEnabled: boolean
  showWaveforms: boolean
  filePath: string | null
  dirty: boolean
  history: { past: Project[]; future: Project[] }
  exportState: ExportState
  toasts: Toast[]
  activeInspectorTab: 'transform' | 'composite' | 'adjust' | 'speed' | 'audio'

  // --- actions ---
  pushHistory(): void
  mutate(recipe: (draft: Project) => void, options?: { silent?: boolean }): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean

  select(ids: string[]): void
  toggleSelect(id: string, additive: boolean): void
  clearSelection(): void

  setPlayhead(t: number): void
  setPlaying(v: boolean): void
  setZoom(v: number): void
  setSnap(v: boolean): void
  setShowWaveforms(v: boolean): void
  setInspectorTab(tab: EditorState['activeInspectorTab']): void

  addAssets(assets: ImportedAsset[]): void
  /** Changes the size, the frame rate or the background of the canvas. */
  setProjectSettings(
    patch: Partial<ProjectSettings> & { manual?: boolean }
  ): void
  addTrack(kind: TrackKind): void
  /** Returns a track of the given kind, creating one if the project has none. */
  ensureTrack(kind: TrackKind): string
  removeTrack(trackId: string): void
  renameTrack(trackId: string, name: string): void
  /** Flips one of the track's boolean switches (visibility, mute, lock). */
  toggleTrackFlag(trackId: string, flag: 'hidden' | 'muted' | 'locked'): void
  /** Reorders a track inside the block of tracks of the same kind. */
  moveTrack(trackId: string, direction: -1 | 1): void
  insertClip(assetId: string, trackId: string, start: number, end?: number): void
  /**
   * Moves a clip to another track and/or to a new start time in one step.
   *
   * A clip may only change tracks to one of the same kind — video stays on
   * video, audio on audio.
   */
  moveClip(clipId: string, targetTrackId: string, start: number): void
  splitAtPlayhead(): void
  /** Splits a single clip at `t`; the other clips are left alone. */
  splitClipAt(clipId: string, t: number): void
  deleteSelected(): void
  duplicateSelected(): void
  setClipProperty(
    clipId: string,
    property: AnimatableProperty,
    value: number,
    options?: { silent?: boolean }
  ): void
  setClipTransform(
    clipId: string,
    patch: Partial<Clip['transform']>,
    options?: { silent?: boolean }
  ): void
  toggleKeyframe(clipId: string, property: AnimatableProperty, t: number, value: number): void
  setKeyframeValue(
    clipId: string,
    property: AnimatableProperty,
    t: number,
    value: number,
    options?: { silent?: boolean }
  ): void
  removeKeyframe(clipId: string, property: AnimatableProperty, t: number): void
  /** Changes one of the clip's colour adjustments. */
  setClipAdjustments(
    clipId: string,
    patch: Partial<ClipAdjustments>,
    options?: { silent?: boolean }
  ): void
  /** Puts every colour adjustment back to its neutral value. */
  resetClipAdjustments(clipId: string): void
  /** Sets a constant playback rate, dropping any speed curve. */
  setClipSpeed(clipId: string, speed: number, options?: { silent?: boolean }): void
  /** Replaces the clip's speed curve and refits its duration. */
  setClipSpeedCurve(
    clipId: string,
    keys: SpeedKeyframe[],
    options?: { silent?: boolean }
  ): void
  /** Removes a keyframe from the clip's speed curve. */
  removeSpeedKeyframe(clipId: string, t: number): void
  /**
   * Moves the clip's audio onto an audio track and mutes the clip itself.
   */
  separateClipAudio(clipId: string): void
  /** Ramps the volume in or out at the clip's edges. */
  applyVolumeFade(
    clipId: string,
    kind: 'in' | 'out',
    duration: number
  ): void
  /** Drops the volume keyframes and returns to a flat volume. */
  clearVolumeCurve(clipId: string): void
  toggleClipMute(clipId: string): void
  /** Puts the clip's transform back to its neutral state. */
  resetClipTransform(clipId: string): void

  setProject(project: Project, filePath: string | null): void
  setFilePath(path: string | null): void
  setDirty(v: boolean): void

  setExportState(state: ExportState): void
  toast(message: string, kind?: 'info' | 'error'): void
  dismissToast(id: number): void
}

function emptyExportState(): ExportState {
  return {
    status: 'idle',
    progress: {
      progress: 0,
      outTime: 0,
      duration: 0,
      speed: '',
      fps: 0,
      bitrate: '',
      totalSize: '',
      eta: ''
    },
    message: '',
    log: []
  }
}

let toastSeq = 0

/**
 * Adds an empty track of the given kind to a project draft.
 *
 * Video tracks are stacked upwards — index 0 is the topmost one and ends up
 * on top of the composition — so a new video track goes above the existing
 * video ones. Audio tracks are appended at the bottom.
 */
function insertTrack(draft: Project, kind: TrackKind): void {
  const track: Track = {
    id: `t_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    kind,
    name: nextTrackName(draft.tracks, kind),
    locked: false,
    hidden: false,
    muted: false,
    clips: []
  }
  if (kind === 'video') {
    const firstVideo = draft.tracks.findIndex((t) => t.kind === 'video')
    draft.tracks.splice(firstVideo === -1 ? 0 : firstVideo, 0, track)
  } else {
    draft.tracks.push(track)
  }
}

/** Sorts keyframes by time — the curve is read from left to right. */
function sortKeyframes(keys: { t: number; value: number }[]): { t: number; value: number }[] {
  return [...keys].sort((a, b) => a.t - b.t)
}

/**
 * Re-fits a clip that was cut in two.
 *
 * A speed curve is anchored to the source, so both halves keep reading the
 * same line; what changes is the stretch of source each half covers, and
 * with it the length of the clip on the timeline.
 */
function splitCurve(left: Clip, right: Clip): void {
  if (!hasSpeedCurve(left)) return
  const splitSource = sourceAtOffset(left, left.duration)
  const sourceEnd = clipSourceEnd(left)

  // The curve is anchored to the source, so both halves keep reading the
  // same line; what changes is the stretch of source each half covers.
  left.sourceDuration = Math.max(0, splitSource - left.inPoint)
  left.duration = outputDuration(left)
  left.speed = averageSpeed(left)

  right.inPoint = splitSource
  right.sourceDuration = Math.max(0, sourceEnd - splitSource)
  right.duration = outputDuration(right)
  right.speed = averageSpeed(right)
}

/**
 * Shortens a clip at its tail.
 *
 * A clip with a speed curve is anchored to its source, so the stretch of
 * source it shows shrinks along with it.
 */
function trimClipEnd(clip: Clip, duration: number): void {
  const length = Math.max(0.01, duration)
  if (hasSpeedCurve(clip)) {
    const sourceEnd = sourceAtOffset(clip, length)
    clip.sourceDuration = Math.max(0, sourceEnd - clip.inPoint)
    clip.duration = outputDuration(clip)
    clip.speed = averageSpeed(clip)
  } else {
    clip.duration = length
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  project: createProject(),
  selectedClipIds: [],
  playhead: 0,
  playing: false,
  pxPerSecond: 60,
  snapEnabled: true,
  showWaveforms: true,
  filePath: null,
  dirty: false,
  history: { past: [], future: [] },
  exportState: emptyExportState(),
  toasts: [],
  activeInspectorTab: 'transform',

  pushHistory: () =>
    set((s) => ({
      history: {
        past: [...s.history.past.slice(-HISTORY_LIMIT), s.project],
        future: []
      }
    })),

  mutate: (recipe, options) => {
    const state = get()
    if (!options?.silent) {
      state.pushHistory()
    }
    const next = produce(state.project, (draft) => {
      recipe(draft)
      draft.modifiedAt = Date.now()
    })
    set({ project: next, dirty: true })
  },

  undo: () =>
    set((s) => {
      if (s.history.past.length === 0) return {}
      const previous = s.history.past[s.history.past.length - 1]
      return {
        project: previous,
        history: {
          past: s.history.past.slice(0, -1),
          future: [s.project, ...s.history.future].slice(0, HISTORY_LIMIT)
        },
        dirty: true
      }
    }),

  redo: () =>
    set((s) => {
      if (s.history.future.length === 0) return {}
      const next = s.history.future[0]
      return {
        project: next,
        history: {
          past: [...s.history.past, s.project].slice(-HISTORY_LIMIT),
          future: s.history.future.slice(1)
        },
        dirty: true
      }
    }),

  canUndo: () => get().history.past.length > 0,
  canRedo: () => get().history.future.length > 0,

  select: (ids) => set({ selectedClipIds: ids }),
  toggleSelect: (id, additive) =>
    set((s) => {
      if (!additive) return { selectedClipIds: [id] }
      return s.selectedClipIds.includes(id)
        ? { selectedClipIds: s.selectedClipIds.filter((x) => x !== id) }
        : { selectedClipIds: [...s.selectedClipIds, id] }
    }),
  clearSelection: () => set({ selectedClipIds: [] }),

  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (v) => set({ playing: v }),
  // The zoom is only held back at the bottom: the top follows the length of
  // the project, so a short timeline can be zoomed in as far as it is useful
  // and a long one can still be scrolled to its end.
  setZoom: (v) =>
    set((s) => {
      const max = maxZoomFor(projectDuration(s.project))
      return { pxPerSecond: Math.min(max, Math.max(MIN_ZOOM, v)) }
    }),
  setSnap: (v) => set({ snapEnabled: v }),
  setShowWaveforms: (v) => set({ showWaveforms: v }),
  setInspectorTab: (tab) => set({ activeInspectorTab: tab }),

  addAssets: (assets) =>
    set((s) => ({
      project: produce(s.project, (draft) => {
        const first = Object.keys(draft.assets).length === 0
        for (const asset of assets) {
          const stored: Asset = { ...asset }
          draft.assets[asset.id] = stored
        }
        // The canvas takes the shape of the first material that comes in —
        // unless the size has already been chosen by hand.
        if (first && !draft.settings.manual && assets.length > 0) {
          const size = canvasSizeFor(assets[0])
          if (size) {
            draft.settings.width = size.width
            draft.settings.height = size.height
          }
        }
        draft.modifiedAt = Date.now()
      }),
      dirty: true
    })),

  setProjectSettings: (patch) =>
    get().mutate((draft) => {
      Object.assign(draft.settings, patch)
      // A size that was set by hand stays — unless the change asks for the
      // canvas to follow the material again.
      if (
        patch.manual === undefined &&
        (patch.width !== undefined || patch.height !== undefined)
      ) {
        draft.settings.manual = true
      }
    }),

  addTrack: (kind) =>
    get().mutate((draft) => {
      insertTrack(draft, kind)
    }),

  ensureTrack: (kind) => {
    const existing = get().project.tracks.find((t) => t.kind === kind)
    if (existing) return existing.id
    // Silent: the caller records its own history step for the whole action.
    get().mutate(
      (draft) => {
        insertTrack(draft, kind)
      },
      { silent: true }
    )
    const created = get().project.tracks.find((t) => t.kind === kind)
    return created ? created.id : ''
  },

  removeTrack: (trackId) => {
    const state = get()
    const track = state.project.tracks.find((t) => t.id === trackId)
    if (!track) return
    state.mutate((draft) => {
      draft.tracks = draft.tracks.filter((t) => t.id !== trackId)
    })
    // Clips on the removed track are gone — drop them from the selection so
    // the inspector does not keep pointing at them.
    const dead = new Set(track.clips.map((c) => c.id))
    if (state.selectedClipIds.some((id) => dead.has(id))) {
      state.select(state.selectedClipIds.filter((id) => !dead.has(id)))
    }
    const clipCount = track.clips.length
    state.toast(
      clipCount > 0
        ? `已删除轨道「${track.name}」及其中的 ${clipCount} 个片段`
        : `已删除轨道「${track.name}」`
    )
  },

  renameTrack: (trackId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    get().mutate((draft) => {
      const track = draft.tracks.find((t) => t.id === trackId)
      if (track) track.name = trimmed
    })
  },

  toggleTrackFlag: (trackId, flag) => {
    get().mutate((draft) => {
      const track = draft.tracks.find((t) => t.id === trackId)
      if (track) track[flag] = !track[flag]
    })
  },

  moveTrack: (trackId, direction) => {
    const state = get()
    const track = state.project.tracks.find((t) => t.id === trackId)
    if (!track) return
    // Video tracks always sit above the audio ones, so a track may only
    // swap places with a sibling of the same kind.
    const siblings = state.project.tracks.filter((t) => t.kind === track.kind)
    const pos = siblings.findIndex((t) => t.id === trackId)
    const target = pos + direction
    if (target < 0 || target >= siblings.length) return

    state.mutate((draft) => {
      const from = draft.tracks.findIndex((t) => t.id === trackId)
      if (from === -1) return
      const [moved] = draft.tracks.splice(from, 1)
      const remaining = draft.tracks.filter((t) => t.kind === moved.kind)
      if (target >= remaining.length) {
        const last = remaining[remaining.length - 1]
        const at = last ? draft.tracks.findIndex((t) => t.id === last.id) + 1 : 0
        draft.tracks.splice(at, 0, moved)
      } else {
        const anchor = remaining[target]
        const at = draft.tracks.findIndex((t) => t.id === anchor.id)
        draft.tracks.splice(at, 0, moved)
      }
    })
  },

  insertClip: (assetId, trackId, start, end) =>
    set((s) => ({
      project: produce(s.project, (draft) => {
        const asset = draft.assets[assetId]
        const track = draft.tracks.find((t) => t.id === trackId)
        if (!asset || !track) return
        // How long the clip is decides where it can go: a clip only takes a
        // place that is free on its lane.
        const duration =
          asset.kind === 'image'
            ? end !== undefined
              ? Math.max(0.1, end - start)
              : 5
            : end !== undefined
              ? Math.max(0.1, Math.min(asset.duration, end - start))
              : asset.duration
        const at = findFreeSlot(occupiedSpans(track), start, duration)
        const clip: Clip = {
          id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          assetId,
          trackId,
          start: at,
          duration,
          inPoint: 0,
          speed: 1,
          opacity: 1,
          volume: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          keyframes: emptyKeyframes(),
          adjustments: defaultAdjustments(),
          muted: false,
          label: asset.name
        }
        track.clips.push(clip)
        track.clips.sort((a, b) => a.start - b.start)
        draft.modifiedAt = Date.now()
      }),
      dirty: true
    })),

  moveClip: (clipId, targetTrackId, start) => {
    const state = get()
    const source = state.project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
    const target = state.project.tracks.find((t) => t.id === targetTrackId)
    if (!source || !target) return
    // Video and audio never swap places.
    if (source.id !== target.id && source.kind !== target.kind) return

    const clip = source.clips.find((c) => c.id === clipId)
    if (!clip) return
    // The clip lands in the free place closest to where it was dropped —
    // two clips never share the same stretch of a lane.
    const at = findFreeSlot(
      occupiedSpans(target, new Set([clipId])),
      start,
      clip.duration
    )

    state.mutate((draft) => {
      const dst = draft.tracks.find((t) => t.id === targetTrackId)
      if (!dst) return
      for (const track of draft.tracks) {
        const index = track.clips.findIndex((c) => c.id === clipId)
        if (index === -1) continue
        const [moved] = track.clips.splice(index, 1)
        moved.start = at
        moved.trackId = dst.id
        dst.clips.push(moved)
        dst.clips.sort((a, b) => a.start - b.start)
        break
      }
    })
  },

  splitAtPlayhead: () =>
    set((s) => {
      const t = s.playhead
      let didSplit = false
      const project = produce(s.project, (draft) => {
        for (const track of draft.tracks) {
          for (const clip of [...track.clips]) {
            const end = clip.start + clip.duration
            if (t <= clip.start + 0.001 || t >= end - 0.001) continue
            const offset = t - clip.start
            const rightId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
            const right: Clip = {
              ...clip,
              id: rightId,
              start: t,
              duration: end - t,
              inPoint: clip.inPoint + offset * clip.speed,
              // The adjustments are copied, not shared: the two halves must
              // be able to drift apart.
              adjustments: normalizeAdjustments(clip.adjustments),
              label: clip.label
            }
            clip.duration = offset
            splitCurve(clip, right)
            track.clips.push(right)
            didSplit = true
          }
          track.clips.sort((a, b) => a.start - b.start)
        }
        draft.modifiedAt = Date.now()
      })
      if (!didSplit) return {}
      return {
        project,
        history: {
          past: [...s.history.past.slice(-HISTORY_LIMIT), s.project],
          future: []
        },
        dirty: true
      }
    }),

  splitClipAt: (clipId, t) => {
    const state = get()
    const clip = state.project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId)
    if (!clip) return
    const end = clip.start + clip.duration
    // Nothing to cut when the playhead is not strictly inside the clip.
    if (t <= clip.start + 0.001 || t >= end - 0.001) return

    state.mutate((draft) => {
      for (const track of draft.tracks) {
        for (const original of [...track.clips]) {
          if (original.id !== clipId) continue
          const offset = t - original.start
          const right: Clip = {
            ...original,
            id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            start: t,
            duration: original.duration - offset,
            inPoint: original.inPoint + offset * original.speed,
            adjustments: normalizeAdjustments(original.adjustments)
          }
          original.duration = offset
          splitCurve(original, right)
          track.clips.push(right)
          track.clips.sort((a, b) => a.start - b.start)
          return
        }
      }
    })
  },

  deleteSelected: () =>
    set((s) => {
      if (s.selectedClipIds.length === 0) return {}
      const ids = new Set(s.selectedClipIds)
      const project = produce(s.project, (draft) => {
        for (const track of draft.tracks) {
          track.clips = track.clips.filter((c) => !ids.has(c.id))
        }
        draft.modifiedAt = Date.now()
      })
      return {
        project,
        history: {
          past: [...s.history.past.slice(-HISTORY_LIMIT), s.project],
          future: []
        },
        selectedClipIds: [],
        dirty: true
      }
    }),

  duplicateSelected: () =>
    set((s) => {
      if (s.selectedClipIds.length === 0) return {}
      const ids = new Set(s.selectedClipIds)
      const newIds: string[] = []
      const project = produce(s.project, (draft) => {
        for (const track of draft.tracks) {
          const originals = track.clips.filter((c) => ids.has(c.id))
          for (const clip of originals) {
            const copyId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
            newIds.push(copyId)
            // The copy goes right behind the original, or into the free
            // place closest to it when the lane is busy there.
            const start = findFreeSlot(
              occupiedSpans(track),
              clip.start + clip.duration,
              clip.duration
            )
            track.clips.push({
              ...clip,
              id: copyId,
              start,
              speedKeyframes: clip.speedKeyframes?.map((k) => ({ ...k })),
              adjustments: normalizeAdjustments(clip.adjustments),
              keyframes: {
                opacity: [...clip.keyframes.opacity],
                volume: [...clip.keyframes.volume],
                scale: [...clip.keyframes.scale],
                x: [...clip.keyframes.x],
                y: [...clip.keyframes.y]
              }
            })
          }
          track.clips.sort((a, b) => a.start - b.start)
        }
        draft.modifiedAt = Date.now()
      })
      return {
        project,
        history: {
          past: [...s.history.past.slice(-HISTORY_LIMIT), s.project],
          future: []
        },
        selectedClipIds: newIds,
        dirty: true
      }
    }),

  setClipProperty: (clipId, property, value, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            if (property === 'opacity') clip.opacity = value
            else if (property === 'volume') clip.volume = value
            else if (property === 'scale') clip.transform.scale = value
            else if (property === 'x') clip.transform.x = value
            else if (property === 'y') clip.transform.y = value
          }
        }
      },
      options
    ),

  setClipTransform: (clipId, patch, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            Object.assign(clip.transform, patch)
          }
        }
      },
      options
    ),

  toggleKeyframe: (clipId, property, t, value) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          const keys = clip.keyframes[property]
          const existing = keys.find((k) => Math.abs(k.t - t) <= 0.02)
          if (existing) {
            clip.keyframes[property] = keys.filter((k) => k !== existing)
          } else {
            clip.keyframes[property] = setKeyframe(keys, t, value)
          }
        }
      }
    }),

  setKeyframeValue: (clipId, property, t, value, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            clip.keyframes[property] = setKeyframe(clip.keyframes[property], t, value)
          }
        }
      },
      options
    ),

  removeKeyframe: (clipId, property, t) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          clip.keyframes[property] = clip.keyframes[property].filter(
            (k) => Math.abs(k.t - t) > 0.02
          )
        }
      }
    }),

  setClipAdjustments: (clipId, patch, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            clip.adjustments = normalizeAdjustments({
              ...(clip.adjustments ?? defaultAdjustments()),
              ...patch
            })
          }
        }
      },
      options
    ),

  resetClipAdjustments: (clipId) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          clip.adjustments = defaultAdjustments()
        }
      }
    }),

  setClipSpeed: (clipId, speed, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            // The stretch of source the clip covers stays put — only the
            // rate changes, so the timeline duration follows.
            const source = clipSourceDuration(clip)
            const still = draft.assets[clip.assetId]?.kind === 'image'
            clip.speed = clampSpeed(speed)
            clip.speedKeyframes = []
            clip.sourceDuration = undefined
            // A picture has no rate to change; it simply stays as long.
            if (!still) clip.duration = source / clip.speed
            // A longer clip pushes its neighbours along rather than
            // running into them.
            pushClipsApart(track.clips, clip.start)
          }
        }
      },
      options
    ),

  setClipSpeedCurve: (clipId, keys, options) =>
    get().mutate(
      (draft) => {
        for (const track of draft.tracks) {
          for (const clip of track.clips) {
            if (clip.id !== clipId) continue
            const source = clipSourceDuration(clip)
            const still = draft.assets[clip.assetId]?.kind === 'image'
            clip.speedKeyframes = keys.map((k) => ({
              t: k.t,
              value: clampSpeed(k.value)
            }))
            if (still) continue
            clip.sourceDuration = source
            clip.duration = outputDuration(clip)
            clip.speed = averageSpeed(clip)
            pushClipsApart(track.clips, clip.start)
          }
        }
      },
      options
    ),

  removeSpeedKeyframe: (clipId, t) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          const source = clipSourceDuration(clip)
          const keys = (clip.speedKeyframes ?? []).filter((k) => Math.abs(k.t - t) > 0.02)
          clip.speedKeyframes = keys
          if (keys.length === 0) {
            // The last keyframe is gone: the clip plays at a constant rate
            // again, at the average the curve used to have.
            clip.sourceDuration = undefined
            clip.duration = source / clip.speed
          } else {
            clip.duration = outputDuration(clip)
            clip.speed = averageSpeed(clip)
          }
          pushClipsApart(track.clips, clip.start)
        }
      }
    }),

  separateClipAudio: (clipId) => {
    const state = get()
    const clip = state.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
    if (!clip) return
    const asset = state.project.assets[clip.assetId]
    if (!asset || !asset.hasAudio) return
    const track = state.project.tracks.find((t) => t.clips.some((c) => c.id === clipId))
    if (!track || track.kind !== 'video') return

    // One undo step covers the new track, the new clip and the muted clip.
    state.pushHistory()
    const audioTrackId = state.ensureTrack('audio')
    let moved = false
    state.mutate(
      (draft) => {
        const audioTrack = draft.tracks.find((t) => t.id === audioTrackId)
        const source = draft.tracks.find((t) => t.clips.some((c) => c.id === clipId))
        if (!audioTrack || !source) return
        const original = source.clips.find((c) => c.id === clipId)
        if (!original) return
        const separated: Clip = {
          ...original,
          id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          trackId: audioTrackId,
          // Only the sound travels; the picture stays behind.
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          keyframes: { ...emptyKeyframes(), volume: [...original.keyframes.volume] },
          muted: false,
          label: `${original.label ?? asset.name} 音频`
        }
        original.muted = true
        // The sound stays where the picture is, so the audio lane makes room
        // for it: what reaches into the place is cut short, what comes after
        // it moves on.
        const from = original.start
        const to = from + original.duration
        for (const other of audioTrack.clips) {
          if (other.start >= to || other.start + other.duration <= from) continue
          if (other.start >= from) continue
          trimClipEnd(other, from - other.start)
          moved = true
        }
        // The clips that follow have to give way as well.
        const others = audioTrack.clips.filter((c) => c.id !== original.id)
        const before = others.map((c) => c.start)
        audioTrack.clips.push(separated)
        pushClipsApart(audioTrack.clips, separated.start)
        audioTrack.clips.sort((a, b) => a.start - b.start)
        if (others.some((c, i) => c.start !== before[i])) moved = true
      },
      { silent: true }
    )
    state.toast(
      moved
        ? '已分离音频到音频轨道，音频轨道上的其它片段已让位'
        : '已分离音频到音频轨道'
    )
  },

  applyVolumeFade: (clipId, kind, duration) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          const length = Math.max(0, Math.min(duration, clip.duration))
          if (length <= 0.001) return
          const keys = clip.keyframes.volume.map((k) => ({ ...k }))
          if (kind === 'in') {
            // The volume at the end of the ramp is what the curve used to
            // hold there, so the fade does not jump.
            const peak = evaluateKeyframes(keys, length, clip.volume)
            const kept = keys.filter((k) => k.t > length + 1e-6)
            clip.keyframes.volume = sortKeyframes([
              { t: 0, value: 0 },
              { t: length, value: peak },
              ...kept
            ])
          } else {
            const start = Math.max(0, clip.duration - length)
            const peak = evaluateKeyframes(keys, start, clip.volume)
            const kept = keys.filter((k) => k.t < start - 1e-6)
            clip.keyframes.volume = sortKeyframes([
              ...kept,
              { t: start, value: peak },
              { t: clip.duration, value: 0 }
            ])
          }
        }
      }
    }),

  clearVolumeCurve: (clipId) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          clip.keyframes.volume = []
        }
      }
    }),

  toggleClipMute: (clipId) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          clip.muted = !clip.muted
        }
      }
    }),

  resetClipTransform: (clipId) =>
    get().mutate((draft) => {
      for (const track of draft.tracks) {
        for (const clip of track.clips) {
          if (clip.id !== clipId) continue
          clip.transform = { x: 0, y: 0, scale: 1, rotation: 0 }
        }
      }
    }),

  setProject: (project, filePath) =>
    set({
      project,
      filePath,
      dirty: false,
      selectedClipIds: [],
      playhead: 0,
      history: { past: [], future: [] }
    }),

  setFilePath: (path) => set({ filePath: path, dirty: false }),
  setDirty: (v) => set({ dirty: v }),

  setExportState: (state) => set({ exportState: state }),

  toast: (message, kind = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, kind === 'error' ? 6000 : 3200)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/**
 * Exposed on `window` so the editor can be driven programmatically — by the
 * smoke-test harness, and by anyone debugging from the devtools console.
 */
if (typeof window !== 'undefined') {
  ;(window as unknown as { __clipforgeEditor?: typeof useEditor }).__clipforgeEditor = useEditor
}

/** The single selected clip, when exactly one is selected. */
export function selectPrimaryClip(state: EditorState): Clip | null {
  if (state.selectedClipIds.length !== 1) return null
  const id = state.selectedClipIds[0]
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (clip.id === id) return clip
    }
  }
  return null
}

export { projectDuration }
