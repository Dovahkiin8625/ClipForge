import type { PreviewEngine } from './previewEngine'

/**
 * A tiny registry so keyboard shortcuts and the transport bar can reach the
 * preview engine without threading it through every component.
 */
let engine: PreviewEngine | null = null

export const transport = {
  get: (): PreviewEngine | null => engine,
  set: (instance: PreviewEngine | null): void => {
    engine = instance
  }
}
