import type { Clip, Project, Track, TrackKind } from '@shared/types'
import { sourceAtOffset } from '@shared/speed'

/** Total length of the timeline, in seconds. */
export function projectDuration(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
  }
  return end
}

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration
}

/* ------------------------------------------------------------------ */
/* Keeping the lanes clear                                              */
/* ------------------------------------------------------------------ */

/** The comparison margin for two edges that should count as touching. */
const EPS = 1e-6

/** A stretch of a track that is already taken by a clip. */
export interface OccupiedSpan {
  start: number
  end: number
  clipId: string
}

/**
 * The stretches of a track that are taken.
 *
 * The clips named in `excludeIds` are left out — a clip that is being moved
 * does not block the place it is moving to.
 */
export function occupiedSpans(
  track: Track,
  excludeIds?: ReadonlySet<string>
): OccupiedSpan[] {
  return track.clips
    .filter((clip) => !excludeIds?.has(clip.id))
    .map((clip) => ({ start: clip.start, end: clipEnd(clip), clipId: clip.id }))
    .sort((a, b) => a.start - b.start)
}

/**
 * The place a clip of `duration` takes on a track so that it covers none of
 * the taken stretches.
 *
 * The clip wants to sit at `desired`. When that place is taken it moves to
 * the free gap that lies closest to it; a gap behind everything else is the
 * last resort, because it always fits.
 *
 * Two clips that only touch — one ends exactly where the other starts — do
 * not count as overlapping.
 */
export function findFreeSlot(
  spans: OccupiedSpan[],
  desired: number,
  duration: number
): number {
  const want = Math.max(0, desired)
  const len = Math.max(0, duration)
  if (len <= 0) return want

  const taken = [...spans].sort((a, b) => a.start - b.start)
  const clashes = taken.some(
    (span) => want < span.end - EPS && span.start < want + len - EPS
  )
  if (!clashes) return want

  // The gaps between the taken stretches.
  const gaps: { start: number; end: number }[] = []
  let cursor = 0
  for (const span of taken) {
    if (span.start - cursor > EPS) gaps.push({ start: cursor, end: span.start })
    cursor = Math.max(cursor, span.end)
  }
  gaps.push({ start: cursor, end: Infinity })

  let best = Infinity
  let bestStart = want
  for (const gap of gaps) {
    if (gap.end - gap.start < len - EPS) continue
    // The clip keeps the place it was aimed at as far as the gap allows.
    const candidate = Math.max(gap.start, Math.min(want, gap.end - len))
    const distance = Math.abs(candidate - want)
    // A tie goes to the later gap: a clip dragged to the right carries on
    // to the right instead of jumping back across what it was dropped on.
    if (distance <= best + EPS) {
      best = distance
      bestStart = candidate
    }
  }
  if (Number.isFinite(best)) return bestStart

  // The lane is packed solid and the clip fits into none of the gaps: it
  // waits behind everything that is already there.
  return taken.length ? taken[taken.length - 1].end : want
}

/**
 * Moves the clips that follow `fromTime` to the right until nothing overlaps.
 *
 * A clip that grows — because its speed changed, say — would otherwise run
 * into its neighbour; the neighbour moves along instead of being buried.
 */
export function pushClipsApart(clips: Clip[], fromTime: number): void {
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  let cursor = -Infinity
  for (const clip of sorted) {
    if (clip.start < fromTime - EPS) {
      // The clips before the change keep the place they have.
      cursor = Math.max(cursor, clipEnd(clip))
      continue
    }
    if (clip.start < cursor - EPS) clip.start = cursor
    cursor = Math.max(cursor, clipEnd(clip))
  }
}

/**
 * Pushes the clips of a lane apart, in the order they start.
 *
 * A file written before the lanes kept their clips apart may still hold two
 * clips on the same spot; the one behind moves along.
 */
export function clearOverlaps(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start)
  pushClipsApart(track.clips, -Infinity)
}

/* ------------------------------------------------------------------ */
/* Zoom                                                                */
/* ------------------------------------------------------------------ */

/**
 * The smallest zoom.
 *
 * At this scale an hour of timeline still fits into a few hundred pixels —
 * far enough out to see the whole project at once, but not so far that the
 * lanes fall apart.
 */
export const MIN_ZOOM = 0.1

/**
 * The widest spacer Chromium can lay out.
 *
 * The timeline scrolls over a spacer as wide as the whole project, so the
 * zoom cannot grow past the point where that spacer overflows.
 */
const MAX_SPACER_PX = 30_000_000

/**
 * The largest zoom that still lets the whole project be scrolled through.
 *
 * The limit follows the length of the project rather than being a fixed
 * number, so a short project can be zoomed far in and a long one still
 * scrolls to its end.
 */
export function maxZoomFor(duration: number): number {
  return Math.max(600, MAX_SPACER_PX / Math.max(1, duration + 30))
}

/** The width of the scrollable spacer for a given zoom. */
export function spacerWidth(duration: number, pxPerSecond: number): number {
  return Math.min(MAX_SPACER_PX, Math.max(0, (duration + 30) * pxPerSecond))
}

/** Maps a zoom onto the 0..1 position of the zoom slider. */
export function zoomToSlider(zoom: number, max: number): number {
  const lo = Math.log(MIN_ZOOM)
  const hi = Math.log(Math.max(MIN_ZOOM * 2, max))
  const value = (Math.log(Math.max(MIN_ZOOM, zoom)) - lo) / (hi - lo)
  return Math.min(1, Math.max(0, value))
}

/** The zoom a slider position stands for. */
export function sliderToZoom(value: number, max: number): number {
  const lo = Math.log(MIN_ZOOM)
  const hi = Math.log(Math.max(MIN_ZOOM * 2, max))
  return Math.exp(lo + Math.min(1, Math.max(0, value)) * (hi - lo))
}

/** The clip occupying `time` on a track, if any. */
export function clipAt(track: Track, time: number): Clip | null {
  for (const clip of track.clips) {
    if (time >= clip.start && time < clipEnd(clip)) return clip
  }
  return null
}

/**
 * Source time a clip should be showing at a given timeline time.
 *
 * Clips with a speed curve do not advance at a constant rate, so the
 * mapping goes through the shared speed helpers.
 */
export function sourceTimeAt(clip: Clip, time: number): number {
  return sourceAtOffset(clip, time - clip.start)
}

/**
 * Picks the next free label for a track of the given kind, e.g. "视频 3".
 *
 * The number is derived from the existing names rather than a counter, so
 * deleting a track never makes the next one collide with an old label.
 */
export function nextTrackName(tracks: Track[], kind: TrackKind): string {
  const prefix = kind === 'video' ? '视频' : '音频'
  let highest = 0
  for (const track of tracks) {
    if (track.kind !== kind) continue
    const m = /(\d+)\s*$/.exec(track.name)
    if (m) highest = Math.max(highest, parseInt(m[1], 10))
  }
  return `${prefix} ${highest + 1}`
}

/** Creates a fresh project. */
export function createProject(name = '未命名项目'): Project {
  const now = Date.now()
  return {
    id: `p_${now.toString(36)}`,
    name,
    settings: { fps: 30, width: 1920, height: 1080, background: '#0b0e13' },
    assets: {},
    tracks: [
      { id: 't_video_2', kind: 'video', name: '视频 2', locked: false, hidden: false, muted: false, clips: [] },
      { id: 't_video_1', kind: 'video', name: '视频 1', locked: false, hidden: false, muted: false, clips: [] },
      { id: 't_audio_1', kind: 'audio', name: '音频 1', locked: false, hidden: false, muted: false, clips: [] }
    ],
    createdAt: now,
    modifiedAt: now
  }
}

/**
 * The canvas size that suits a piece of media.
 *
 * The canvas takes the shape of the material, so that a vertical video
 * ends up in a vertical project. The short side is brought down to 1080 —
 * a 4K clip does not have to make a 4K project — but nothing is blown up.
 * H.264 wants even numbers, so the sizes are rounded down.
 */
export function canvasSizeFor(material: {
  width: number
  height: number
}): { width: number; height: number } | null {
  if (!material.width || !material.height) return null
  const shortSide = Math.min(material.width, material.height)
  const longSide = Math.max(material.width, material.height)
  let scale = shortSide >= 1080 ? 1080 / shortSide : 1
  scale = Math.min(scale, 3840 / longSide)
  return {
    width: even(Math.round(material.width * scale)),
    height: even(Math.round(material.height * scale))
  }
}

function even(n: number): number {
  const v = Math.max(2, Math.round(n))
  return v % 2 === 0 ? v : v - 1
}
