/**
 * Shared between main, preload and renderer. This module must stay free of any
 * Node or DOM specific imports — it is bundled into all three contexts.
 */

export type ID = string

export type AssetKind = 'video' | 'audio' | 'image'

export interface SpriteSheet {
  /** Absolute path to the generated sprite image on disk. */
  path: string
  /** `clipforge://` URL the renderer can load into an <img>. */
  url: string
  /** Number of frames per row. */
  cols: number
  /** Number of rows actually produced. */
  rows: number
  /** Total frames in the sheet. */
  count: number
  /** Pixel size of a single frame inside the sheet. */
  frameWidth: number
  frameHeight: number
  /** Source-time (seconds) of the first frame in the sheet. */
  startTime: number
  /** Source-time (seconds) between two consecutive frames. */
  interval: number
}

export interface Asset {
  id: ID
  name: string
  path: string
  /** Resolved `clipforge://` URL the renderer can hand to <video>. */
  url?: string
  kind: AssetKind
  /** Duration in seconds. Images report 0 and use a default still length. */
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  codec: string
  sizeBytes: number
  /** Thumbnail sprite used by the timeline filmstrip. */
  sprite?: SpriteSheet
  /**
   * Normalised audio peaks (0..1). `waveformBuckets` tells how many peaks
   * cover one second of source audio.
   */
  waveform?: Float32Array
  waveformBuckets: number
  createdAt: number
}

export interface Keyframe {
  /** Seconds relative to the clip's start on the timeline. */
  t: number
  value: number
}

/**
 * A point on a clip's speed curve.
 *
 * Unlike the other keyframes, `t` is a position in the *source* (seconds
 * into the media file) rather than on the timeline: the curve describes how
 * fast the source is played back, so it has to stay anchored to the source
 * when the clip is trimmed or moved.
 */
export interface SpeedKeyframe {
  /** Source time, in seconds, the keyframe sits at. */
  t: number
  /** Playback rate at that point, 1 being the original speed. */
  value: number
}

export type AnimatableProperty = 'opacity' | 'volume' | 'scale' | 'x' | 'y'

export type KeyframeMap = Record<AnimatableProperty, Keyframe[]>

export interface ClipTransform {
  /** Normalised offset from centre, -1..1 of the frame width/height. */
  x: number
  y: number
  scale: number
  /** Degrees. */
  rotation: number
}

/**
 * Colour and detail adjustments applied to a clip.
 *
 * Every value is a plain number so that a project survives a save/load round
 * trip untouched. The tonal values run from -1 to 1 and the effects from 0
 * to 1 — the inspector shows them as percentages.
 */
export interface ClipAdjustments {
  /** Additive lift of the whole picture, -1..1. */
  brightness: number
  /** Contrast around the middle grey, -1..1. */
  contrast: number
  /** Colour saturation, -1 (greyscale) to 1 (twice as colourful). */
  saturation: number
  /** Colour temperature, -1 (cool) to 1 (warm). */
  temperature: number
  /** Shadow recovery, -1 (crushed) to 1 (lifted). */
  shadows: number
  /** Highlight recovery, -1 (pulled down) to 1 (boosted). */
  highlights: number
  /** Unsharp mask amount, 0..1. */
  sharpen: number
  /** Blur radius, 0..1. */
  blur: number
  /** Film grain, 0..1. */
  grain: number
}

export interface Clip {
  id: ID
  assetId: ID
  trackId: ID
  /** Timeline position of the clip's first frame, in seconds. */
  start: number
  /** Timeline length of the clip, in seconds (already accounts for `speed`). */
  duration: number
  /** Source in-point, in seconds. */
  inPoint: number
  /** Playback rate multiplier. */
  speed: number
  /**
   * Speed curve. When it holds keyframes the clip plays at a varying rate
   * and `speed` only records the average, so that switching back to a
   * constant rate keeps the clip roughly where it was.
   */
  speedKeyframes?: SpeedKeyframe[]
  /**
   * Length of the source the clip consumes, in seconds.
   *
   * Only clips with a speed curve carry it: there the rate no longer
   * describes the stretch on its own, so the source range has to be kept
   * apart from the timeline duration.
   */
  sourceDuration?: number
  opacity: number
  volume: number
  transform: ClipTransform
  keyframes: KeyframeMap
  /**
   * Colour adjustments. Optional so that projects written before the
   * feature existed still load; the editor fills in the neutral values.
   */
  adjustments?: ClipAdjustments
  muted: boolean
  label?: string
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: ID
  kind: TrackKind
  name: string
  locked: boolean
  hidden: boolean
  muted: boolean
  /** Clips sorted by `start`, ascending. */
  clips: Clip[]
}

export interface ProjectSettings {
  fps: number
  width: number
  height: number
  /** Background colour of the composition (hex, #RRGGBB). */
  background: string
  /**
   * Set once the size has been chosen by hand.
   *
   * Until then the canvas takes the shape of the first material that comes
   * in, which is what most people expect from a project.
   */
  manual?: boolean
}

export interface Project {
  id: ID
  name: string
  settings: ProjectSettings
  assets: Record<ID, Asset>
  /**
   * Ordered top-to-bottom: index 0 is the topmost track and is drawn last
   * (so it ends up on top of the composition).
   */
  tracks: Track[]
  createdAt: number
  modifiedAt: number
}

/* ------------------------------------------------------------------ */
/* Media probing                                                       */
/* ------------------------------------------------------------------ */

export interface ProbeResult {
  path: string
  name: string
  kind: AssetKind
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  codec: string
  sizeBytes: number
}

export interface ImportedAsset extends Asset {
  /** Resolved `clipforge://` URL the renderer can feed to <video>. */
  url: string
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export type ExportPreset = 'web' | 'high' | 'master'

/** What an export run produces. */
export type ExportKind = 'video' | 'audio' | 'gif'

/** The container and codec an audio-only export is written in. */
export type AudioFormat = 'mp3' | 'wav' | 'm4a' | 'flac'

/** How the palette of an animated GIF is smoothed. */
export type GifDither = 'none' | 'bayer' | 'sierra2'

/** The picture and the timing of an animated GIF. */
export interface GifOptions {
  /** Width in pixels; the height follows the aspect ratio. */
  width: number
  /** Frames per second. */
  fps: number
  /** How many times the GIF repeats. 0 means forever. */
  loop: number
  dither: GifDither
}

export interface ExportOptions {
  path: string
  kind: ExportKind
  /** Video only. */
  preset: ExportPreset
  /** Overrides the project resolution when set. */
  width?: number
  height?: number
  fps?: number
  /** Estimated bitrate in kbps, derived from the preset when omitted. */
  bitrate?: number
  /** Audio only: the container and codec to write. */
  audioFormat?: AudioFormat
  /** Audio only: the bitrate in kbps for the lossy formats. */
  audioBitrate?: number
  /** GIF only: the picture and the timing. */
  gif?: GifOptions
}

/** Asks the main process for a place to write an export. */
export interface ExportRequest {
  defaultName: string
  kind: ExportKind
  /** Only for the audio export: the container to write. */
  format?: AudioFormat
}

export interface ExportProgress {
  /** 0..1 */
  progress: number
  /** Seconds of output produced so far. */
  outTime: number
  /** Total seconds, when known. */
  duration: number
  /** ffmpeg speed multiplier, e.g. "12.5x". */
  speed: string
  fps: number
  bitrate: string
  totalSize: string
  eta: string
}

export type ExportStatus = 'idle' | 'preparing' | 'running' | 'done' | 'error' | 'cancelled'

export interface ExportState {
  status: ExportStatus
  progress: ExportProgress
  message: string
  log: string[]
  outputPath?: string
}

/* ------------------------------------------------------------------ */
/* IPC surface                                                         */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  ffmpegPath: string
  ffprobePath: string
  version: string
  platform: string
}

export interface Api {
  app: {
    info(): Promise<AppInfo>
  }
  media: {
    /** Opens the native file picker and imports the chosen files. */
    importFiles(): Promise<ImportedAsset[]>
    /** Imports specific absolute paths (used for drag & drop). */
    importPaths(paths: string[]): Promise<ImportedAsset[]>
    /** Generates (or returns cached) a thumbnail sprite for a time window. */
    sprite(
      path: string,
      startTime: number,
      endTime: number,
      columns: number,
      frameWidth?: number
    ): Promise<SpriteSheet>
    /** Extracts audio peaks for an asset. */
    waveform(path: string, duration: number): Promise<{ peaks: number[]; buckets: number }>
    /** Resolves the absolute path of a dropped `File`. */
    pathForFile(file: File): string
  }
  project: {
    save(project: Project, filePath: string): Promise<void>
    load(filePath: string): Promise<Project | null>
    /** Opens a native save dialog and returns the chosen path. */
    chooseSaveProject(defaultName: string): Promise<string | null>
    /** Opens a native open dialog and returns the chosen path. */
    chooseOpenProject(): Promise<string | null>
  }
  export: {
    start(project: Project, options: ExportOptions): Promise<void>
    cancel(): Promise<void>
    /** Opens the native save dialog for the exported file. */
    chooseOutput(request: ExportRequest): Promise<string | null>
    /** Shows the exported file in the OS file manager. */
    reveal(path: string): Promise<void>
    onProgress(cb: (p: ExportProgress) => void): () => void
    onState(cb: (s: ExportState) => void): () => void
  }
  dialog: {
    message(options: { type?: 'info' | 'error' | 'warning'; title?: string; message: string }): Promise<void>
  }
}

export type Unsubscribe = () => void
