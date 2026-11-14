import { useEditor } from '@/state/store'

export function Toasts(): React.JSX.Element {
  const toasts = useEditor((s) => s.toasts)

  return (
    <div className="toast-layer" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast${toast.kind === 'error' ? ' toast--error' : ''}`}>
          <span className="toast__dot" />
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  )
}
