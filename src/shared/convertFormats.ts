/**
 * The catalogue of containers a conversion can write.
 *
 * It lives in `shared` because both sides need it: the renderer draws the
 * pickers from it, and the main process turns the chosen codec into an
 * FFmpeg command line from it. Keeping one list means a container can never
 * offer a codec the encoder does not know.
 */

export type ConvertMedia = 'video' | 'audio'

export interface CodecOption {
  /** The name FFmpeg knows the encoder by. */
  id: string
  label: string
}

export interface FormatSpec {
  label: string
  ext: string
  media: ConvertMedia
  /** Video encoders this container accepts. */
  videoCodecs: CodecOption[]
  /** Audio encoders this container accepts. */
  audioCodecs: CodecOption[]
  /** The encoder used when the user does not choose one. */
  defaultVideoCodec?: string
  defaultAudioCodec?: string
  /**
   * The encoders that carry no audio at all (GIF), where the audio pickers
   * are hidden rather than merely ignored.
   */
  videoOnly?: boolean
}

const H264: CodecOption = { id: 'libx264', label: 'H.264' }
const H265: CodecOption = { id: 'libx265', label: 'H.265' }
const VP9: CodecOption = { id: 'libvpx-vp9', label: 'VP9' }
const VP8: CodecOption = { id: 'libvpx', label: 'VP8' }
const MPEG4: CodecOption = { id: 'mpeg4', label: 'MPEG-4' }
const GIF: CodecOption = { id: 'gif', label: 'GIF' }
const PRORES: CodecOption = { id: 'prores', label: 'ProRes' }

const AAC: CodecOption = { id: 'aac', label: 'AAC' }
const MP3: CodecOption = { id: 'libmp3lame', label: 'MP3' }
const OPUS: CodecOption = { id: 'libopus', label: 'Opus' }
const VORBIS: CodecOption = { id: 'libvorbis', label: 'Vorbis' }
const PCM: CodecOption = { id: 'pcm_s16le', label: 'PCM 16-bit' }
const FLAC: CodecOption = { id: 'flac', label: 'FLAC' }

export const FORMATS: Record<string, FormatSpec> = {
  mp4: {
    label: 'MP4',
    ext: 'mp4',
    media: 'video',
    videoCodecs: [H264, H265],
    audioCodecs: [AAC, MP3],
    defaultVideoCodec: H264.id,
    defaultAudioCodec: AAC.id
  },
  mov: {
    label: 'MOV',
    ext: 'mov',
    media: 'video',
    videoCodecs: [H264, H265, PRORES],
    audioCodecs: [AAC, PCM],
    defaultVideoCodec: H264.id,
    defaultAudioCodec: AAC.id
  },
  mkv: {
    label: 'MKV',
    ext: 'mkv',
    media: 'video',
    videoCodecs: [H264, H265, VP9],
    audioCodecs: [AAC, OPUS, FLAC],
    defaultVideoCodec: H264.id,
    defaultAudioCodec: AAC.id
  },
  webm: {
    label: 'WebM',
    ext: 'webm',
    media: 'video',
    videoCodecs: [VP9, VP8],
    audioCodecs: [OPUS, VORBIS],
    defaultVideoCodec: VP9.id,
    defaultAudioCodec: OPUS.id
  },
  avi: {
    label: 'AVI',
    ext: 'avi',
    media: 'video',
    videoCodecs: [MPEG4],
    audioCodecs: [MP3],
    defaultVideoCodec: MPEG4.id,
    defaultAudioCodec: MP3.id
  },
  gif: {
    label: 'GIF',
    ext: 'gif',
    media: 'video',
    videoCodecs: [GIF],
    audioCodecs: [],
    defaultVideoCodec: GIF.id,
    videoOnly: true
  },
  mp3: {
    label: 'MP3',
    ext: 'mp3',
    media: 'audio',
    videoCodecs: [],
    audioCodecs: [MP3],
    defaultAudioCodec: MP3.id
  },
  wav: {
    label: 'WAV',
    ext: 'wav',
    media: 'audio',
    videoCodecs: [],
    audioCodecs: [PCM],
    defaultAudioCodec: PCM.id
  },
  m4a: {
    label: 'M4A',
    ext: 'm4a',
    media: 'audio',
    videoCodecs: [],
    audioCodecs: [AAC],
    defaultAudioCodec: AAC.id
  },
  flac: {
    label: 'FLAC',
    ext: 'flac',
    media: 'audio',
    videoCodecs: [],
    audioCodecs: [FLAC],
    defaultAudioCodec: FLAC.id
  }
}

/** The formats offered in the picker, in the order they are shown. */
export const FORMAT_ORDER: string[] = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'gif',
  'mp3',
  'wav',
  'm4a',
  'flac'
]

/** True when the format carries sound only and has no picture at all. */
export function isAudioOnly(format: string): boolean {
  return FORMATS[format]?.media === 'audio'
}

/**
 * The CRF value behind a quality preset.
 *
 * Lower is better and bigger: the three steps are roughly "visually
 * lossless", "clearly good" and "small".
 */
export const QUALITY_CRF: Record<string, number> = {
  high: 18,
  medium: 23,
  low: 28
}
