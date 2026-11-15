import type { VocalProviderKind, VocalServiceModel } from '@shared/vocals'

/**
 * What a provider is told while it works.
 *
 * Every provider — the local filter as much as the neural network behind the
 * service — reports through the same two channels, so the runner does not
 * have to care which one it is talking to.
 */
export interface VocalProviderContext {
  /** Reports progress (0..1) and a message for the user. */
  report(progress: number, message: string): void
  /** True once the user has asked to stop. */
  cancelled(): boolean
  /** A directory the provider may write into. */
  workDir: string
}

/**
 * A way of lifting the voice out of a recording.
 *
 * The interface is deliberately narrow: the provider is handed a WAV file and
 * returns a WAV file. Everything else — trimming the clip out of its source,
 * tempo, naming, storage — is the runner's business, which keeps every
 * provider interchangeable.
 *
 * Adding a model is a matter of implementing this interface somewhere else:
 * a new class next to the ones below, or a new provider inside the
 * separation service. Neither side of the app has to change.
 */
export interface VocalProvider {
  id: string
  label: string
  kind: VocalProviderKind
  /** The model the provider was asked to run, if it runs one. */
  readonly modelId?: string
  /** The models the provider can run. Empty for a plain filter. */
  models(): Promise<VocalServiceModel[]>
  /** Whether the provider can run right now, and why not if it cannot. */
  available(): Promise<{ available: boolean; reason?: string }>
  /**
   * Separates the voice out of a WAV file.
   *
   * Resolves with the path of the result. The provider writes it wherever it
   * likes — the runner copies it into the app's storage.
   */
  separate(sourceWav: string, ctx: VocalProviderContext): Promise<{ path: string; duration: number }>
}
