/**
 * The contract between ClipForge and a vocal separation service.
 *
 * The service is deliberately *not* part of the application. It is a separate
 * program (see `services/vocal-separator`) that ClipForge talks to over
 * plain HTTP. That keeps the neural-network side out of the app bundle: the
 * app has to work on machines that have neither Python nor a model, and the
 * service is free to grow models of its own without touching ClipForge.
 *
 * Everything in this file is the wire format. The service mirrors it in
 * `vocal_separator/protocol.py`; the two must be changed together.
 */

/** What a provider does to the sound. */
export type VocalProviderKind =
  /** A trained neural network — the good stuff, the slow stuff. */
  | 'model'
  /** A classic signal-processing filter — fast, free, approximate. */
  | 'filter'

export interface VocalServiceModel {
  /** Stable identifier, passed back when a job is started. */
  id: string
  label: string
}

/** A separation method the app can offer, wherever it actually lives. */
export interface VocalProviderInfo {
  id: string
  label: string
  kind: VocalProviderKind
  available: boolean
  reason?: string
}

export interface VocalServiceProvider {
  id: string
  label: string
  kind: VocalProviderKind
  models: VocalServiceModel[]
  /** Whether the provider can run right now (dependencies installed...). */
  available: boolean
  /** Why it cannot run, when it cannot. */
  reason?: string
}

export interface VocalServiceHealth {
  status: 'ok' | 'error'
  version: string
  providers: VocalServiceProvider[]
}

/** The job as the service reports it. */
export type VocalJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface VocalJob {
  id: string
  status: VocalJobStatus
  /** 0..1 */
  progress: number
  message: string
  provider?: string
  model?: string
  /** Service-local path of the result. Only meaningful for a local service. */
  resultPath?: string
  /** Identifier the result is downloaded under. */
  fileId?: string
  /** Length of the result in seconds. */
  duration?: number
  error?: string
}

/** The request the app sends for one clip. */
export interface VocalSeparateRequest {
  /** Absolute path of the source media. */
  sourcePath: string
  /** Where in the source the clip starts, in seconds. */
  start?: number
  /** How much of the source the clip uses, in seconds. */
  duration?: number
  /** The clip's playback rate; the separated audio is delivered at it. */
  speed?: number
  /** Base name for the result file. */
  name?: string
  /** Preferred provider; the service picks a sensible one when absent. */
  provider?: string
  /** Preferred model of the chosen provider. */
  model?: string
}

/** The state of the separation as the app shows it. */
export interface VocalState {
  status: 'idle' | 'running' | 'done' | 'error'
  /** 0..1 */
  progress: number
  message: string
  provider?: string
  model?: string
  error?: string
}

/** What the app gets back from a finished separation. */
export interface VocalSeparateResult {
  /** Absolute path of the separated audio, inside the app's own storage. */
  path: string
  /** `clipforge://` URL the renderer can hand to an <audio> element. */
  url: string
  /** Length of the separated audio in seconds. */
  duration: number
  /** The provider that produced it. */
  provider: string
  /** The model it used, if it used one. */
  model?: string
  /** The name the service gave the provider. */
  label: string
}
