import { useEffect, useState } from 'react'
import { api } from '@/bridge'

/**
 * Shown when FFmpeg cannot be found. Without it the app can still edit and
 * preview, but it cannot generate thumbnails, waveforms or export.
 */
export function FfmpegWarning(): React.JSX.Element | null {
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.app
      .info()
      .then((info) => {
        if (!cancelled) setMissing(!info.ffmpegPath || !info.ffprobePath)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (!missing) return null

  return (
    <div className="ffmpeg-warning" role="alert">
      <span className="ffmpeg-warning__title">未找到 FFmpeg</span>
      <span className="ffmpeg-warning__body">
        缩略图、波形与导出功能需要 FFmpeg。请安装并加入系统 PATH，或设置 CLIPFORGE_FFMPEG 环境变量指向 ffmpeg.exe。
      </span>
    </div>
  )
}
