import type { Clip, SpeedKeyframe } from './types'

/**
 * The playback rates the editor offers.
 *
 * The lower bound keeps a clip from being frozen to a single frame, the
 * upper one keeps the export from producing unwatchable footage.
 */
export const MIN_SPEED = 0.25
export const MAX_SPEED = 8

/** A stretch of the source that plays back at one constant rate. */
export interface SpeedSegment {
  /** Source time the segment starts at. */
  s0: number
  /** Source time the segment ends at. */
  s1: number
  /** Playback rate across the segment. */
  rate: number
  /** Output time, relative to the clip's start, the segment begins at. */
  u0: number
}

/** Clamps a playback rate to the supported range. */
export function clampSpeed(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, rate))
}

/**
 * Length of the source a clip consumes.
 *
 * A clip without a speed curve derives it from its duration and rate. A
 * clip with a curve keeps it: the rate varies over the clip and therefore
 * no longer describes the stretch on its own.
 */
export function clipSourceDuration(clip: Clip): number {
  if (clip.sourceDuration !== undefined) return Math.max(0, clip.sourceDuration)
  return Math.max(0, clip.duration * clip.speed)
}

/** Source time the clip ends at. */
export function clipSourceEnd(clip: Clip): number {
  return clip.inPoint + clipSourceDuration(clip)
}

/** The clip's speed curve, sorted by time. */
export function speedCurve(clip: Clip): SpeedKeyframe[] {
  return [...(clip.speedKeyframes ?? [])].sort((a, b) => a.t - b.t)
}

/** Whether the clip plays at a varying rate. */
export function hasSpeedCurve(clip: Clip): boolean {
  return (clip.speedKeyframes?.length ?? 0) > 0
}

/**
 * The rate the curve asks for at a point of the source.
 *
 * Outside the curve's own extent the rate is held flat, so trimming a clip
 * never makes the picture jump.
 */
export function curveRateAt(keys: SpeedKeyframe[], source: number): number {
  if (keys.length === 0) return 1
  if (source <= keys[0].t) return keys[0].value
  const last = keys[keys.length - 1]
  if (source >= last.t) return last.value
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (source >= a.t && source <= b.t) {
      const span = b.t - a.t
      if (span <= 1e-9) return b.value
      const k = (source - a.t) / span
      return a.value + (b.value - a.value) * k
    }
  }
  return last.value
}

/**
 * How finely a straight stretch of the curve is cut into pieces.
 *
 * The curve is read as a line, but it is played back in pieces of one
 * constant rate: that keeps the mapping between source time and timeline
 * time exactly reversible, which the preview and the export both rely on.
 * The pieces are small enough for the rate to really change along the
 * line, and the sound is cut the same way so the two stay in step.
 */
const CURVE_STEP = 0.5
const CURVE_MAX_PIECES = 12

/**
 * Splits the clip's source range into stretches that play at one constant
 * rate.
 *
 * The rate of a piece is the mean of the line across it — for a straight
 * line that is the mean of its two ends.
 */
export function speedSegments(clip: Clip): SpeedSegment[] {
  const s0 = clip.inPoint
  const s1 = clipSourceEnd(clip)
  const keys = speedCurve(clip)

  if (keys.length === 0 || s1 - s0 <= 1e-9) {
    return [{ s0, s1: Math.max(s0, s1), rate: clampSpeed(clip.speed), u0: 0 }]
  }

  // The curve is cut at every keyframe it holds inside the clip's range.
  const cuts: number[] = [s0]
  for (const key of keys) {
    if (key.t > s0 + 1e-9 && key.t < s1 - 1e-9) cuts.push(key.t)
  }
  cuts.push(s1)

  const segments: SpeedSegment[] = []
  let u = 0
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]
    const b = cuts[i + 1]
    const pieces = Math.min(
      CURVE_MAX_PIECES,
      Math.max(1, Math.round((b - a) / CURVE_STEP))
    )
    for (let p = 0; p < pieces; p++) {
      const pa = a + ((b - a) * p) / pieces
      const pb = a + ((b - a) * (p + 1)) / pieces
      const rate = Math.max(
        MIN_SPEED,
        (curveRateAt(keys, pa) + curveRateAt(keys, pb)) / 2
      )
      segments.push({ s0: pa, s1: pb, rate, u0: u })
      u += (pb - pa) / rate
    }
  }
  return segments
}

/** Length of the clip's output, in seconds. */
export function outputDuration(clip: Clip): number {
  let total = 0
  for (const segment of speedSegments(clip)) {
    total += (segment.s1 - segment.s0) / segment.rate
  }
  return total
}

/** Source time shown at an output offset, relative to the clip's start. */
export function sourceAtOffset(clip: Clip, offset: number): number {
  const segments = speedSegments(clip)
  if (segments.length === 0) return clip.inPoint
  for (const segment of segments) {
    const length = (segment.s1 - segment.s0) / segment.rate
    if (offset <= segment.u0 + length + 1e-9) {
      return segment.s0 + (offset - segment.u0) * segment.rate
    }
  }
  const last = segments[segments.length - 1]
  return last.s1
}

/** Output offset, relative to the clip's start, a source time is shown at. */
export function offsetAtSource(clip: Clip, source: number): number {
  const segments = speedSegments(clip)
  for (const segment of segments) {
    if (source <= segment.s1 + 1e-9) {
      return segment.u0 + (source - segment.s0) / segment.rate
    }
  }
  const last = segments[segments.length - 1]
  return last.u0 + (last.s1 - last.s0) / last.rate
}

/** The playback rate in effect at an output offset. */
export function rateAtOffset(clip: Clip, offset: number): number {
  const segments = speedSegments(clip)
  for (const segment of segments) {
    const length = (segment.s1 - segment.s0) / segment.rate
    if (offset <= segment.u0 + length + 1e-9) return segment.rate
  }
  return segments.length > 0 ? segments[segments.length - 1].rate : 1
}

/** The rate the clip plays back at, on average. */
export function averageSpeed(clip: Clip): number {
  const source = clipSourceDuration(clip)
  const output = outputDuration(clip)
  return output > 1e-9 ? source / output : clip.speed
}
