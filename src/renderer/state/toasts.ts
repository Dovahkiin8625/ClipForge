import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

interface ToastState {
  toasts: Toast[]
  /** Shows a message in the corner of the window. */
  toast(message: string, kind?: 'info' | 'error'): void
  dismissToast(id: number): void
}

let toastSeq = 0

/**
 * The messages in the corner of the window.
 *
 * They belong to the window, not to the project: the editor, the converter
 * and the downloader all report through them, so they live in a store of
 * their own instead of inside the editor's.
 */
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  toast: (message, kind = 'info') => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(
      () => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      },
      kind === 'error' ? 6000 : 3200
    )
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Shows a message in the corner of the window. */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  useToasts.getState().toast(message, kind)
}
