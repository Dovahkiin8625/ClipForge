/**
 * The colour adjustments of a clip.
 *
 * This module is the single source of truth for how the adjustments behave:
 * the preview shader, the export filter graph and the inspector all read
 * their numbers from here, so the preview and the exported file stay in
 * step.
 */

import type { ClipAdjustments } from './types'

/**
 * How hard the shadow and highlight sliders push the tone curve.
 *
 * The curve is applied per channel, which is what FFmpeg's `curves` filter
 * does as well — the preview and the export therefore agree.
 */
export const TONE_STRENGTH = 0.3

/** The range of every adjustment, as `[min, max]`. */
export const ADJUSTMENT_RANGES: Record<keyof ClipAdjustments, [number, number]> = {
  brightness: [-1, 1],
  contrast: [-1, 1],
  saturation: [-1, 1],
  temperature: [-1, 1],
  shadows: [-1, 1],
  highlights: [-1, 1],
  sharpen: [0, 1],
  blur: [0, 1],
  grain: [0, 1]
}

/** The adjustment keys in the order the inspector shows them. */
export const ADJUSTMENT_KEYS = Object.keys(ADJUSTMENT_RANGES) as (keyof ClipAdjustments)[]

/** A clip with every adjustment at its neutral value. */
export function defaultAdjustments(): ClipAdjustments {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    shadows: 0,
    highlights: 0,
    sharpen: 0,
    blur: 0,
    grain: 0
  }
}

/** Fills in the missing values and clamps everything into its range. */
export function normalizeAdjustments(
  partial?: Partial<ClipAdjustments> | null
): ClipAdjustments {
  const result = defaultAdjustments()
  if (!partial) return result
  for (const key of ADJUSTMENT_KEYS) {
    const value = partial[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const [min, max] = ADJUSTMENT_RANGES[key]
    result[key] = Math.min(max, Math.max(min, value))
  }
  return result
}

/** True when the adjustments would not change a single pixel. */
export function isNeutral(adjustments?: ClipAdjustments | null): boolean {
  if (!adjustments) return true
  return ADJUSTMENT_KEYS.every((key) => Math.abs(adjustments[key]) < 0.001)
}

/**
 * The tone curve the shadow and highlight sliders describe.
 *
 * The shadows are the dark end of the curve and the highlights the bright
 * end; lifting one and pulling the other down is what a colourist means by
 * "recovering" them.
 */
export function toneCurve(x: number, shadows: number, highlights: number): number {
  const shadow = shadows * TONE_STRENGTH * (1 - x) * (1 - x)
  const highlight = highlights * TONE_STRENGTH * x * x
  return Math.min(1, Math.max(0, x + shadow + highlight))
}

/**
 * The whole per-channel tone chain: brightness, then contrast, then the
 * shadow and highlight curve.
 *
 * The three steps are all per-channel, so they collapse into a single
 * curve — which is what the export hands to FFmpeg.
 */
export function toneChain(x: number, adjustments: ClipAdjustments): number {
  let v = x + adjustments.brightness
  v = (v - 0.5) * (1 + adjustments.contrast) + 0.5
  v = Math.min(1, Math.max(0, v))
  return toneCurve(v, adjustments.shadows, adjustments.highlights)
}

/**
 * The tone chain as control points for FFmpeg's `curves` filter.
 *
 * The filter works on normalised coordinates and interpolates between the
 * points, so the curve is sampled densely — including where it turns the
 * corner, which a uniform grid would step over.
 */
export function toneChainPoints(adjustments: ClipAdjustments, steps = 16): string {
  const c = 1 + adjustments.contrast
  const xs: number[] = []
  for (let i = 0; i <= steps; i++) xs.push(i / steps)

  // The two places where the brightness and contrast push the picture out
  // of the range and it has to be clamped.
  for (const edge of [0.5 - adjustments.brightness - 0.5 / c, 0.5 - adjustments.brightness + 0.5 / c]) {
    if (edge > 0.001 && edge < 0.999) xs.push(edge)
  }
  xs.sort((a, b) => a - b)

  const points: string[] = []
  for (const x of xs) {
    const y = toneChain(x, adjustments)
    const last = points[points.length - 1]
    if (last) {
      const previous = Number(last.split('/')[0])
      if (x - previous < 0.002) continue
    }
    points.push(`${x.toFixed(5)}/${y.toFixed(5)}`)
  }
  return points.join(' ')
}
