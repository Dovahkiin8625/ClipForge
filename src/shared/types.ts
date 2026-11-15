/**
 * Shared between main, preload and renderer. This module must stay free of any
 * Node or DOM specific imports — it is bundled into all three contexts.
 */

import type {
  VocalProviderInfo,
  VocalSeparateRequest,
  VocalSeparateResult,
  VocalState
} from './vocals'

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
/* Format conversion                                                   */
/* ------------------------------------------------------------------ */

/** The containers a conversion can write. */
export type ConvertFormat =
  | 'mp4'
  | 'mov'
  | 'mkv'
  | 'webm'
  | 'avi'
  | 'gif'
  | 'mp3'
  | 'wav'
  | 'm4a'
  | 'flac'

/** The trade-off between file size and quality. */
export type ConvertQuality = 'high' | 'medium' | 'low'

export interface ConvertOptions {
  /** Absolute path of the source file. */
  input: string
  /** Directory the converted file is written to. */
  outputDir: string
  /** File name without the extension. */
  fileName: string
  format: ConvertFormat
  /** Video codec; ignored by the audio-only formats. */
  videoCodec?: string
  /** Audio codec; ignored by the video-only formats. */
  audioCodec?: string
  /** Target width in pixels; omitted keeps the source size. */
  width?: number
  /** Target height in pixels; omitted keeps the source size. */
  height?: number
  /** Target frame rate; omitted keeps the source rate. */
  fps?: number
  quality?: ConvertQuality
  /** Audio bitrate in kbps for the lossy formats. */
  audioBitrate?: number
  /** Start time in seconds; omitted converts the whole file. */
  start?: number
  /** Length in seconds; omitted converts to the end. */
  duration?: number
}

export interface ConvertProgress {
  /** 0..1 */
  progress: number
  /** Seconds of output produced so far. */
  outTime: number
  /** Total seconds, when known. */
  duration: number
  /** ffmpeg speed multiplier, e.g. "12.5x". */
  speed: string
  eta: string
}

export type ConvertStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface ConvertState {
  status: ConvertStatus
  progress: ConvertProgress
  message: string
  log: string[]
  outputPath?: string
}

/* ------------------------------------------------------------------ */
/* Video download                                                      */
/* ------------------------------------------------------------------ */

/** One downloadable rendition of a video. */
export interface VideoFormatOption {
  /** The format id yt-dlp knows the rendition by. */
  id: string
  label: string
  ext: string
  width: number
  height: number
  fps: number
  /** Estimated size in bytes, when the site reports one. */
  sizeBytes?: number
  /** Whether the rendition carries sound. */
  hasAudio: boolean
}

export interface VideoInfo {
  url: string
  title: string
  thumbnail?: string
  duration: number
  /** The site the video came from, e.g. "YouTube". */
  extractor: string
  formats: VideoFormatOption[]
}

export interface DownloadOptions {
  url: string
  /** The rendition to take; omitted picks the best available. */
  formatId?: string
  /** Directory the file is written to. */
  outputDir: string
  /** File name without extension; omitted lets the site decide. */
  fileName?: string
  /** The title of the video; only used to label the entry in the list. */
  title?: string
}

export interface DownloadProgress {
  /** 0..1 */
  progress: number
  speed: string
  eta: string
  totalSize: string
  downloaded: string
}

export type DownloadStatus =
  | 'idle'
  | 'parsing'
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DownloadState {
  status: DownloadStatus
  message: string
  progress: DownloadProgress
  /** Absolute path of the finished file. */
  outputPath?: string
}

/** One entry of the download list. The list lives in the main process so it
 *  survives switching workspaces and restarts of the app. */
export interface DownloadTask {
  id: string
  url: string
  title: string
  /** The rendition that was picked, by yt-dlp's id. */
  formatId: string
  fileName: string
  outputDir: string
  status: DownloadStatus
  message: string
  progress: DownloadProgress
  /** Absolute path of the finished file. */
  outputPath?: string
  createdAt: number
}

/** The state of the download form; it is kept so a link is never lost. */
export interface DownloadForm {
  url: string
  formatId: string
  fileName: string
  outputDir: string
  autoImport: boolean
}

/** Where the yt-dlp binary was found, if at all. */
export interface YtdlpInfo {
  available: boolean
  path: string
  version: string
  /** Set when the binary has to be installed by the user. */
  hint: string
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
    /** The user's download folder, used as the default output directory. */
    downloadsPath(): Promise<string>
  }
  media: {
    /** Opens the native file picker and imports the chosen files. */
    importFiles(): Promise<ImportedAsset[]>
    /** Reads the metadata of a file without importing it. */
    probe(path: string): Promise<ProbeResult>
    /** Imports specific absolute paths (used for drag & drop). */
    importPaths(paths: string[]): Promise<ImportedAsset[]>
    /** Generates (or returns cached) a thumbnail sprite for a time window. */
    sprite(
      path: string,
      startTime: number,
      endTime: number,
      columns: number,
      frameWidth?: number,
      /** The file is a single still picture, not a recording. */
      still?: boolean
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
  convert: {
    /** Opens the native picker and returns the chosen source file. */
    chooseInput(): Promise<string | null>
    /** Opens the native picker and returns the chosen output directory. */
    chooseOutputDir(): Promise<string | null>
    /** Starts a conversion; progress arrives through the event callbacks. */
    start(options: ConvertOptions): Promise<void>
    cancel(): Promise<void>
    onProgress(cb: (p: ConvertProgress) => void): () => void
    onState(cb: (s: ConvertState) => void): () => void
  }
  download: {
    /** Reports whether a yt-dlp binary is available. */
    locate(): Promise<YtdlpInfo>
    /** Lets the user point at a yt-dlp binary; the choice is remembered. */
    chooseBinary(): Promise<YtdlpInfo>
    /** Reads the metadata of a link without downloading it. */
    parse(url: string): Promise<VideoInfo>
    /** Starts a download; the list is updated through the event callback. */
    start(options: DownloadOptions): Promise<DownloadTask>
    /** The whole download list, newest first. */
    tasks(): Promise<DownloadTask[]>
    /** Cancels a task; a queued task is only dropped. */
    cancel(id: string): Promise<void>
    /** Removes a task from the list. */
    remove(id: string): Promise<void>
    /** Removes every finished task from the list. */
    clearFinished(): Promise<void>
    /** Opens the finished file with the system program. */
    open(id: string): Promise<void>
    /** Shows the finished file in the file manager. */
    reveal(id: string): Promise<void>
    /** The saved state of the download form. */
    getForm(): Promise<DownloadForm>
    /** Saves the state of the download form. */
    saveForm(form: DownloadForm): Promise<void>
    onState(cb: (s: DownloadState) => void): () => void
    /** Fires whenever the download list changes. */
    onTasks(cb: (tasks: DownloadTask[]) => void): () => void
  }
  vocal: {
    /** The separation methods that are available right now. */
    providers(): Promise<VocalProviderInfo[]>
    /** Separates the voice out of a clip's audio. */
    separate(request: VocalSeparateRequest): Promise<VocalSeparateResult>
    /** Stops a running separation. */
    cancel(): Promise<void>
    /** Fires while a separation runs. */
    onState(cb: (s: VocalState) => void): () => void
  }
}

export type Unsubscribe = () => void
