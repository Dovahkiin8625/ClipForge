import type { Asset, Clip, ClipAdjustments, Keyframe, Project } from '@shared/types'
import { clipSourceDuration, hasSpeedCurve, speedSegments } from '@shared/speed'
import { toneChainPoints } from '@shared/adjustments'

/**
 * Translates a ClipForge project into an FFmpeg filter graph.
 *
 * Layout model (mirrors the preview exactly):
 *   • The composition is a `color` source of the project resolution.
 *   • Every clip is scaled to *fit* its frame, then composited with `overlay`.
 *   • `enable='between(t,start,end)'` places each clip on the timeline, so
 *     gaps show the background colour exactly like the preview does.
 *
 * Time-based expressions (opacity, volume, scale, position) are all driven by
 * the clip-local clock: the clip is normalised to PTS 0 with `setpts`, every
 * animated filter runs on that local clock, and only the very last step
 * shifts the clip to its timeline position.
 */

export interface BuiltGraph {
  filterComplex: string
  /** The label the finished picture hangs on; null when there is none. */
  videoLabel: string | null
  /** The label of the mixed sound; null when the project is silent. */
  audioLabel: string | null
  inputArgs: string[]
  duration: number
  warnings: string[]
}

/** Which parts of the composition the graph is built for. */
export interface GraphOptions {
  /** Build the chains that composite the picture. */
  video?: boolean
  /** Build the chains that mix the sound. */
  audio?: boolean
}

/** Wraps an expression so FFmpeg's filter parser treats it as one token. */
function q(expr: string): string {
  return `'${expr.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function hexToFfmpeg(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  return m ? `0x${m[1]}` : '0x000000'
}

/**
 * Builds a piecewise-linear expression from keyframes, evaluated against the
 * variable `t` (seconds).
 */
export function keyframeExpression(keyframes: Keyframe[], timeVar = 't'): string {
  if (keyframes.length === 0) return '0'
  if (keyframes.length === 1) return String(keyframes[0].value)

  const ks = [...keyframes].sort((a, b) => a.t - b.t)
  let expr = String(ks[ks.length - 1].value)

  for (let i = ks.length - 2; i >= 0; i--) {
    const a = ks[i]
    const b = ks[i + 1]
    const span = b.t - a.t
    let segment: string
    if (span <= 1e-6) {
      segment = String(b.value)
    } else {
      const slope = (b.value - a.value) / span
      segment = `(${a.value.toFixed(6)}+(${slope.toFixed(8)})*(${timeVar}-${a.t.toFixed(6)}))`
    }
    expr = `if(lt(${timeVar},${b.t.toFixed(6)}),${segment},${expr})`
  }
  return expr
}

/** Splits a speed change into a chain of `atempo` filters inside [0.5, 2]. */
function atempoChain(speed: number): string[] {
  const out: string[] = []
  let remaining = speed
  let guard = 0
  while (remaining > 2.0 && guard++ < 8) {
    out.push('atempo=2.000000')
    remaining /= 2
  }
  while (remaining < 0.5 && guard++ < 16) {
    out.push('atempo=0.500000')
    remaining /= 0.5
  }
  out.push(`atempo=${remaining.toFixed(6)}`)
  return out
}

/**
 * Builds the expression that maps a source timestamp onto the clip's own
 * timeline.
 *
 * A clip with a speed curve plays in stretches of one constant rate, so the
 * mapping is a staircase of straight lines — one per stretch. `PTS` is the
 * timestamp of the incoming frame, which the trim filter left at its
 * position in the source.
 */
function curveTimeExpression(clip: Clip): string {
  const segments = speedSegments(clip)
  let expr = ''
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    const line = `(${segment.u0.toFixed(6)}+((PTS-${segment.s0.toFixed(6)})/${segment.rate.toFixed(6)}))`
    expr =
      i === segments.length - 1 ? line : `if(lt(PTS,${segment.s1.toFixed(6)}),${line},${expr})`
  }
  return expr
}

interface ClipPlan {
  clip: Clip
  asset: Asset
  inputIndex: number
}

function projectDuration(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration)
  }
  return end
}

interface FadeShape {
  /** Duration of the fade-in ramp; 0 when there is none. */
  inDur: number
  /** Duration of the fade-out ramp; 0 when there is none. */
  outDur: number
  /** Opacity reached on the plateau between the ramps. */
  peak: number
}

/**
 * Recognises the common "fade in, hold, fade out" shape.
 *
 * Such a curve is expressible with the far cheaper `fade` filter, whereas an
 * arbitrary curve has to go through `geq` — which is accurate but slow.
 * Returns null when the keyframes need the general path.
 */
function detectFade(keyframes: Keyframe[]): FadeShape | null {
  if (keyframes.length < 2 || keyframes.length > 4) return null
  const ks = [...keyframes].sort((a, b) => a.t - b.t)

  const peak = Math.max(...ks.map((k) => k.value))
  if (peak <= 0.001) return null
  // Every keyframe must sit either on the plateau or exactly on zero.
  for (const k of ks) {
    if (k.value > 0.001 && Math.abs(k.value - peak) > 0.001) return null
  }

  let inDur = 0
  let outDur = 0

  if (ks[0].value <= 0.001) {
    const next = ks.find((k) => k.value > 0.001)
    if (!next) return null
    inDur = next.t - ks[0].t
  }
  const last = ks[ks.length - 1]
  if (last.value <= 0.001) {
    const prev = [...ks].reverse().find((k) => k.value > 0.001)
    if (!prev) return null
    outDur = last.t - prev.t
  }
  if (inDur === 0 && outDur === 0) return null
  return { inDur, outDur, peak }
}

export function buildGraph(project: Project, options: GraphOptions = {}): BuiltGraph {
  const warnings: string[] = []
  const duration = projectDuration(project)

  // --- Collect inputs, one per unique asset -----------------------------
  const assets = Object.values(project.assets)
  const inputArgs: string[] = []
  const inputIndexByAsset = new Map<string, number>()
  // FFmpeg numbers inputs by the order of their `-i` flags, not by their
  // position in the argument list.
  let inputCount = 0

  for (const asset of assets) {
    inputIndexByAsset.set(asset.id, inputCount)
    inputCount++
    if (asset.kind === 'image') {
      inputArgs.push('-loop', '1', '-t', '3600', '-i', asset.path)
    } else {
      inputArgs.push('-i', asset.path)
    }
  }

  const filters: string[] = []
  const videoClips: ClipPlan[] = []
  const audioClips: ClipPlan[] = []

  // An export that only wants the sound leaves the picture out — the chains
  // that composite it are expensive and would go to waste.
  const videoLabel =
    options.video === false
      ? null
      : buildVideoChains(project, filters, videoClips, warnings, inputIndexByAsset)
  const audioLabel =
    options.audio === false
      ? null
      : buildAudioChains(project, filters, audioClips, inputIndexByAsset)

  return {
    filterComplex: filters.join(';'),
    videoLabel,
    audioLabel,
    inputArgs,
    duration,
    warnings
  }
}

/**
 * Builds the chains that composite the picture.
 *
 * Returns the label the finished composition hangs on.
 */
function buildVideoChains(
  project: Project,
  filters: string[],
  videoClips: ClipPlan[],
  warnings: string[],
  inputIndexByAsset: Map<string, number>
): string {
  const { width: W, height: H, fps, background } = project.settings
  const duration = projectDuration(project)

  // --- Background --------------------------------------------------------
  filters.push(
    `color=c=${hexToFfmpeg(background)}:s=${W}x${H}:r=${fps}:d=${Math.max(duration, 0.1).toFixed(4)},format=yuva420p[bg]`
  )

  // --- Video chains ------------------------------------------------------
  let vIndex = 0
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      const asset = project.assets[clip.assetId]
      if (!asset) continue
      const inputIndex = inputIndexByAsset.get(asset.id)
      if (inputIndex === undefined) continue
      videoClips.push({ clip, asset, inputIndex })
    }
  }

  // Order by track (bottom first) then by time so the graph matches the
  // preview's compositing order.
  const orderedVideo = orderByTrack(project, videoClips)

  let current = 'bg'
  for (const plan of orderedVideo) {
    const { clip, asset, inputIndex } = plan
    const label = `vc${vIndex++}`
    const out = `vo${vIndex - 1}`

    const srcDur = Math.max(0.01, clip.duration * clip.speed)
    const inEnd = clip.inPoint + srcDur
    const isImage = asset.kind === 'image'
    const speed = isImage ? 1 : clip.speed
    const curved = !isImage && hasSpeedCurve(clip)

    const parts: string[] = []
    if (isImage) {
      parts.push(`trim=start=0:end=${Math.max(0.04, clip.duration).toFixed(4)}`)
      parts.push('setpts=PTS-STARTPTS')
    } else if (curved) {
      // The source is stretched over the clip's own timeline in stretches
      // of one constant rate.
      const end = clip.inPoint + clipSourceDuration(clip)
      parts.push(`trim=start=${clip.inPoint.toFixed(4)}:end=${end.toFixed(4)}`)
      parts.push(`setpts=${q(curveTimeExpression(clip))}`)
      warnings.push('变速曲线按小段近似导出，音频与画面可能有细微出入。')
    } else {
      parts.push(`trim=start=${clip.inPoint.toFixed(4)}:end=${inEnd.toFixed(4)}`)
      parts.push(`setpts=(PTS-STARTPTS)/${speed.toFixed(6)}`)
    }
    parts.push(`fps=${fps}`)

    // --- scale ----------------------------------------------------------
    const srcW = asset.width || W
    const srcH = asset.height || H
    const fit = Math.min(W / srcW, H / srcH)

    // The source is first fitted into the frame; the adjustments then work
    // on the picture as it will be seen, and only afterwards is the clip's
    // own scale applied. The preview does it in the same order.
    if (Math.abs(fit - 1) > 1e-6) {
      parts.push(`scale=w=${q(`iw*${fit.toFixed(8)}`)}:h=${q(`ih*${fit.toFixed(8)}`)}`)
    }

    parts.push(...adjustmentFilters(clip.adjustments))

    const scaleKeys = clip.keyframes.scale
    if (scaleKeys.length >= 2) {
      const expr = keyframeExpression(scaleKeys)
      parts.push(
        `scale=w=${q(`iw*(${expr})`)}:h=${q(`ih*(${expr})`)}:eval=frame`
      )
    } else if (Math.abs(clip.transform.scale - 1) > 1e-6) {
      const s = clip.transform.scale
      parts.push(`scale=w=${q(`iw*${s.toFixed(8)}`)}:h=${q(`ih*${s.toFixed(8)}`)}`)
    }

    // --- rotation (static) ----------------------------------------------
    if (Math.abs(clip.transform.rotation) > 0.01) {
      const rad = (clip.transform.rotation * Math.PI) / 180
      parts.push(`rotate=${rad.toFixed(6)}:fillcolor=0x00000000:ow=${q('hypot(iw,ih)')}:oh=${q('hypot(iw,ih)')}`)
    }

    // --- opacity ---------------------------------------------------------
    const opKeys = clip.keyframes.opacity
    parts.push('format=yuva420p')
    if (opKeys.length >= 2) {
      const fade = detectFade(opKeys)
      if (fade) {
        if (fade.inDur > 0.001) {
          const d = Math.max(0.01, Math.min(clip.duration, fade.inDur))
          parts.push(`fade=t=in:st=0:d=${d.toFixed(4)}:alpha=1`)
        }
        if (fade.outDur > 0.001) {
          const d = Math.max(0.01, Math.min(clip.duration, fade.outDur))
          const st = Math.max(0, clip.duration - d)
          parts.push(`fade=t=out:st=${st.toFixed(4)}:d=${d.toFixed(4)}:alpha=1`)
        }
        const mult = clip.opacity * fade.peak
        if (Math.abs(mult - 1) > 0.001) {
          parts.push(`colorchannelmixer=aa=${mult.toFixed(4)}`)
        }
      } else {
        const expr = keyframeExpression(opKeys)
        parts.push(
          `geq=r=${q('r(X,Y)')}:g=${q('g(X,Y)')}:b=${q('b(X,Y)')}:a=${q(`alpha(X,Y)*(${expr})`)}`
        )
        warnings.push('不透明度使用了复杂关键帧，导出速度会明显变慢。')
      }
    } else if (Math.abs(clip.opacity - 1) > 0.001) {
      parts.push(`colorchannelmixer=aa=${clip.opacity.toFixed(4)}`)
    }

    // --- place on the timeline ------------------------------------------
    parts.push(`setpts=PTS-STARTPTS+${clip.start.toFixed(4)}/TB`)
    filters.push(`[${inputIndex}:v]${parts.join(',')}[${label}]`)

    // --- composite --------------------------------------------------------
    const xExpr = `(${W}-w)/2+(${clip.transform.x.toFixed(6)})*(${W})/2`
    const yExpr = `(${H}-h)/2+(${clip.transform.y.toFixed(6)})*(${H})/2`
    const xKeys = clip.keyframes.x
    const yKeys = clip.keyframes.y
    const fx = xKeys.length >= 2 ? keyframeExpression(xKeys) : String(clip.transform.x)
    const fy = yKeys.length >= 2 ? keyframeExpression(yKeys) : String(clip.transform.y)
    const finalX = xKeys.length >= 2 ? `(${W}-w)/2+(${fx})*(${W})/2` : xExpr
    const finalY = yKeys.length >= 2 ? `(${H}-h)/2+(${fy})*(${H})/2` : yExpr

    filters.push(
      `[${current}][${label}]overlay=x=${q(finalX)}:y=${q(finalY)}:eof_action=pass:repeatlast=0:` +
        `enable=${q(`between(t,${clip.start.toFixed(4)},${(clip.start + clip.duration).toFixed(4)})`)}[${out}]`
    )
    current = out
  }

  return current
}

/**
 * Builds the chains that mix the sound.
 *
 * Returns the label of the mix, or null when the project is silent.
 */
function buildAudioChains(
  project: Project,
  filters: string[],
  audioClips: ClipPlan[],
  inputIndexByAsset: Map<string, number>
): string | null {
  const duration = projectDuration(project)

  // --- Audio chains ------------------------------------------------------
  let aIndex = 0
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      const asset = project.assets[clip.assetId]
      if (!asset || !asset.hasAudio || clip.muted || asset.kind === 'image') continue
      const inputIndex = inputIndexByAsset.get(asset.id)
      if (inputIndex === undefined) continue
      audioClips.push({ clip, asset, inputIndex })
    }
  }

  const orderedAudio = orderByTrack(project, audioClips)
  const audioLabels: string[] = []

  for (const plan of orderedAudio) {
    const { clip, inputIndex } = plan
    const label = `ac${aIndex++}`
    // The label holding the clip's sound on the clip's own clock.
    let source: string

    if (hasSpeedCurve(clip)) {
      // Every stretch of the source is cut out and compressed on its own,
      // then the pieces are stitched back together — that is what puts the
      // sound under the picture of a clip with a speed curve.
      const segments = speedSegments(clip)
      const pieces: string[] = []
      segments.forEach((segment, index) => {
        const piece = `${label}_s${index}`
        const chain = [
          `atrim=start=${segment.s0.toFixed(4)}:end=${segment.s1.toFixed(4)}`,
          'asetpts=PTS-STARTPTS'
        ]
        if (Math.abs(segment.rate - 1) > 0.001) chain.push(...atempoChain(segment.rate))
        filters.push(`[${inputIndex}:a]${chain.join(',')}[${piece}]`)
        pieces.push(piece)
      })
      if (pieces.length > 1) {
        source = `${label}_cat`
        filters.push(
          `${pieces.map((p) => `[${p}]`).join('')}concat=n=${pieces.length}:v=0:a=1[${source}]`
        )
      } else {
        source = pieces[0]
      }
    } else {
      const srcDur = Math.max(0.01, clip.duration * clip.speed)
      const chain = [
        `atrim=start=${clip.inPoint.toFixed(4)}:end=${(clip.inPoint + srcDur).toFixed(4)}`,
        'asetpts=PTS-STARTPTS'
      ]
      if (!isImageAsset(plan.asset.kind) && Math.abs(clip.speed - 1) > 0.001) {
        chain.push(...atempoChain(clip.speed))
      }
      source = `${label}_src`
      filters.push(`[${inputIndex}:a]${chain.join(',')}[${source}]`)
    }

    const parts: string[] = []
    const volKeys = clip.keyframes.volume
    if (volKeys.length >= 2) {
      const expr = keyframeExpression(volKeys)
      parts.push(`volume=${q(expr)}:eval=frame`)
    } else if (Math.abs(clip.volume - 1) > 0.001) {
      parts.push(`volume=${clip.volume.toFixed(4)}`)
    }
    parts.push(`adelay=${Math.round(clip.start * 1000)}:all=1`)
    parts.push(`apad=whole_dur=${Math.max(duration, 0.1).toFixed(4)}`)
    filters.push(`[${source}]${parts.join(',')}[${label}]`)
    audioLabels.push(label)
  }

  let audioLabel: string | null = null
  if (audioLabels.length === 1) {
    filters.push(`[${audioLabels[0]}]atrim=0:${Math.max(duration, 0.1).toFixed(4)},asetpts=PTS-STARTPTS[aout]`)
    audioLabel = 'aout'
  } else if (audioLabels.length > 1) {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:` +
        `duration=longest:dropout_transition=0:normalize=0,` +
        `atrim=0:${Math.max(duration, 0.1).toFixed(4)},asetpts=PTS-STARTPTS[aout]`
    )
    audioLabel = 'aout'
  }

  return audioLabel
}

function isImageAsset(kind: string): boolean {
  return kind === 'image'
}

/**
 * The FFmpeg filters that reproduce a clip's colour adjustments.
 *
 * The order is the one the preview shader uses: blur, sharpen, the tone
 * (brightness, contrast, shadows and highlights), the saturation, the
 * colour temperature and finally the grain.
 *
 * The tone is a single `curves` filter because all of its steps work on
 * one channel at a time; the saturation needs the colour around it and
 * therefore goes through `eq`.
 */
function adjustmentFilters(adjustments: ClipAdjustments | undefined): string[] {
  if (!adjustments) return []
  const parts: string[] = []

  if (adjustments.blur > 0.001) {
    parts.push(`gblur=sigma=${(adjustments.blur * 10).toFixed(3)}`)
  }
  if (adjustments.sharpen > 0.001) {
    // The chroma is left alone — only the luma is sharpened.
    parts.push(`unsharp=lx=5:ly=5:la=${(adjustments.sharpen * 1.2).toFixed(3)}:ca=0`)
  }

  const toned =
    Math.abs(adjustments.brightness) > 0.001 ||
    Math.abs(adjustments.contrast) > 0.001 ||
    Math.abs(adjustments.shadows) > 0.001 ||
    Math.abs(adjustments.highlights) > 0.001
  if (toned) {
    parts.push(`curves=all=${q(toneChainPoints(adjustments))}`)
  }

  if (Math.abs(adjustments.saturation) > 0.001) {
    parts.push(`eq=saturation=${(1 + adjustments.saturation).toFixed(4)}`)
  }

  if (Math.abs(adjustments.temperature) > 0.001) {
    const r = 1 + adjustments.temperature * 0.15
    const b = 1 - adjustments.temperature * 0.15
    parts.push(`colorchannelmixer=rr=${r.toFixed(4)}:bb=${b.toFixed(4)}`)
  }

  if (adjustments.grain > 0.001) {
    // Luma only, and without the temporal flag so the grain sits still.
    parts.push(`noise=alls=${Math.round(adjustments.grain * 100)}:c0s=0:c1s=0:allf=u`)
  }

  return parts
}

/**
 * Sorts clip plans so that the bottom-most track is composited first and the
 * top-most track last. Tracks are stored top-to-bottom, so the index is
 * descending here.
 */
function orderByTrack(project: Project, plans: ClipPlan[]): ClipPlan[] {
  const trackIndex = new Map<string, number>()
  project.tracks.forEach((t, i) => trackIndex.set(t.id, i))
  return [...plans].sort((a, b) => {
    const ta = trackIndex.get(a.clip.trackId) ?? 0
    const tb = trackIndex.get(b.clip.trackId) ?? 0
    if (ta !== tb) return tb - ta
    return a.clip.start - b.clip.start
  })
}
