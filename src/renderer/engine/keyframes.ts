import type { Keyframe, KeyframeMap } from '@shared/types'

export function emptyKeyframes(): KeyframeMap {
  return { opacity: [], volume: [], scale: [], x: [], y: [] }
}

/** Reads the value of an animated property at a point in time. */
export function evaluateKeyframes(
  keys: Keyframe[],
  t: number,
  fallback: number
): number {
  if (!keys || keys.length === 0) return fallback
  if (keys.length === 1) return keys[0].value
  if (t <= keys[0].t) return keys[0].value
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.value
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      if (span <= 1e-9) return b.value
      const k = (t - a.t) / span
      return a.value + (b.value - a.value) * k
    }
  }
  return fallback
}

const KEY_EPSILON = 0.02

/** Inserts or replaces the keyframe nearest to `t`. */
export function setKeyframe(keys: Keyframe[], t: number, value: number): Keyframe[] {
  const next = keys.filter((k) => Math.abs(k.t - t) > KEY_EPSILON)
  next.push({ t, value })
  next.sort((a, b) => a.t - b.t)
  return next
}
