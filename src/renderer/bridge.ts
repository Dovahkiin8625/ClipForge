import type { Api } from '@shared/types'

declare global {
  interface Window {
    clipforge: Api
  }
}

/** The typed bridge to the Electron main process. */
export const api: Api = window.clipforge
