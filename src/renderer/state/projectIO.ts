import { useCallback } from 'react'
import { useEditor } from './store'
import { toast } from './toasts'
import { api } from '@/bridge'
import type { Project } from '@shared/types'
import { normalizeAdjustments } from '@shared/adjustments'
import { clearOverlaps } from '@/engine/timeline'

/** Strips runtime-only fields (thumbnail sprites, waveform arrays) before saving. */
function serialise(project: Project): Project {
  const assets: Record<string, Project['assets'][string]> = {}
  for (const [id, asset] of Object.entries(project.assets)) {
    assets[id] = { ...asset }
    delete assets[id].sprite
    delete assets[id].waveform
  }
  return { ...project, assets }
}

export function useProjectIO(): {
  open: () => Promise<void>
  save: () => Promise<void>
  saveAs: () => Promise<void>
} {
  const open = useCallback(async () => {
    const path = await api.project.chooseOpenProject()
    if (!path) return
    const project = await api.project.load(path)
    if (!project) {
      toast('无法读取该项目文件', 'error')
      return
    }
    // Older files may be missing fields that the editor now expects.
    const settings = project.settings ?? ({} as Partial<Project['settings']>)
    const migrated: Project = {
      ...project,
      settings: {
        fps: settings.fps ?? 30,
        width: settings.width ?? 1920,
        height: settings.height ?? 1080,
        background: settings.background ?? '#0b0e13',
        manual: settings.manual ?? false
      },
      tracks: (project.tracks ?? []).map((track) => ({
        id: track.id,
        kind: track.kind ?? 'video',
        name: track.name ?? '轨道',
        locked: track.locked ?? false,
        hidden: track.hidden ?? false,
        muted: track.muted ?? false,
        clips: (track.clips ?? []).map((clip) => ({
          id: clip.id,
          assetId: clip.assetId,
          trackId: clip.trackId,
          start: clip.start ?? 0,
          duration: clip.duration ?? 0,
          inPoint: clip.inPoint ?? 0,
          opacity: clip.opacity ?? 1,
          volume: clip.volume ?? 1,
          speed: clip.speed ?? 1,
          speedKeyframes: (clip.speedKeyframes ?? []).map((k) => ({
            t: k.t,
            value: k.value
          })),
          sourceDuration: clip.sourceDuration,
          muted: clip.muted ?? false,
          label: clip.label,
          transform: {
            x: clip.transform?.x ?? 0,
            y: clip.transform?.y ?? 0,
            scale: clip.transform?.scale ?? 1,
            rotation: clip.transform?.rotation ?? 0
          },
          adjustments: normalizeAdjustments(clip.adjustments),
          keyframes: {
            opacity: clip.keyframes?.opacity ?? [],
            volume: clip.keyframes?.volume ?? [],
            scale: clip.keyframes?.scale ?? [],
            x: clip.keyframes?.x ?? [],
            y: clip.keyframes?.y ?? []
          }
        }))
      }))
    }
    // A file written before the lanes kept their clips apart may still hold
    // two clips on the same spot; the one behind moves along.
    for (const track of migrated.tracks) clearOverlaps(track)
    useEditor.getState().setProject(migrated, path)
    toast(`已打开 ${migrated.name}`)
  }, [])

  const save = useCallback(async () => {
    const store = useEditor.getState()
    let path = store.filePath
    if (!path) {
      path = await api.project.chooseSaveProject(store.project.name)
      if (!path) return
    }
    await api.project.save(serialise(store.project), path)
    useEditor.getState().setFilePath(path)
    toast('项目已保存')
  }, [])

  const saveAs = useCallback(async () => {
    const store = useEditor.getState()
    const path = await api.project.chooseSaveProject(store.project.name)
    if (!path) return
    await api.project.save(serialise(store.project), path)
    useEditor.getState().setFilePath(path)
    toast('项目已另存为')
  }, [])

  return { open, save, saveAs }
}
