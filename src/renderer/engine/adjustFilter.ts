import type { ClipAdjustments } from '@shared/types'
import { TONE_STRENGTH } from '@shared/adjustments'

/**
 * The colour adjustments of a clip, applied on the GPU.
 *
 * The preview needs the same picture as the exported file, and it needs it
 * while the user drags a slider. A fragment shader is the only way to get
 * there: the tonal work (shadows, highlights, grain) touches every pixel
 * and would be far too slow in JavaScript.
 *
 * The filter works on the picture at the size the clip occupies in the
 * composition — the export scales the source into the frame first as well —
 * so a blur covers the same number of pixels in both.
 */

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_texture;
uniform vec2 u_texel;
uniform vec2 u_resolution;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
uniform float u_shadows;
uniform float u_highlights;
uniform float u_sharpen;
uniform float u_blur;
uniform float u_grain;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

// The tone curve the shadow and highlight sliders describe. The export
// writes the same quadratic into its curves filter.
float tone(float x) {
  float shadow = u_shadows * ${TONE_STRENGTH} * (1.0 - x) * (1.0 - x);
  float highlight = u_highlights * ${TONE_STRENGTH} * x * x;
  return clamp(x + shadow + highlight, 0.0, 1.0);
}

// A hash that does not move: the grain has to sit still, otherwise it
// reads as noise rather than as film.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// The 3x3 binomial kernel the unsharp mask measures against.
vec3 blurSmall(vec2 uv) {
  vec2 o = u_texel;
  vec3 s = texture(u_texture, uv).rgb * 4.0;
  s += (texture(u_texture, uv + vec2(o.x, 0.0)).rgb + texture(u_texture, uv - vec2(o.x, 0.0)).rgb) * 2.0;
  s += (texture(u_texture, uv + vec2(0.0, o.y)).rgb + texture(u_texture, uv - vec2(0.0, o.y)).rgb) * 2.0;
  s += (texture(u_texture, uv + o).rgb + texture(u_texture, uv - o).rgb);
  s += (texture(u_texture, uv + vec2(o.x, -o.y)).rgb + texture(u_texture, uv + vec2(-o.x, o.y)).rgb);
  return s / 16.0;
}

// A wide, soft blur: the taps spread as the radius grows.
vec3 blurWide(vec2 uv, float radius) {
  vec2 o = u_texel * radius;
  vec3 s = texture(u_texture, uv).rgb * 0.25;
  s += (texture(u_texture, uv + vec2(o.x, 0.0)).rgb + texture(u_texture, uv - vec2(o.x, 0.0)).rgb) * 0.15;
  s += (texture(u_texture, uv + vec2(0.0, o.y)).rgb + texture(u_texture, uv - vec2(0.0, o.y)).rgb) * 0.15;
  s += (texture(u_texture, uv + o).rgb + texture(u_texture, uv - o).rgb) * 0.075;
  s += (texture(u_texture, uv + vec2(o.x, -o.y)).rgb + texture(u_texture, uv + vec2(-o.x, o.y)).rgb) * 0.075;
  s += (texture(u_texture, uv + vec2(o.x * 2.0, 0.0)).rgb + texture(u_texture, uv + vec2(-o.x * 2.0, 0.0)).rgb) * 0.04;
  s += (texture(u_texture, uv + vec2(0.0, o.y * 2.0)).rgb + texture(u_texture, uv + vec2(0.0, -o.y * 2.0)).rgb) * 0.04;
  return s / 1.31;
}

void main() {
  vec3 color = texture(u_texture, v_uv).rgb;

  if (u_blur > 0.0) {
    float radius = 1.0 + u_blur * 10.0;
    color = mix(color, blurWide(v_uv, radius), min(1.0, u_blur * 1.5));
  }

  if (u_sharpen > 0.0) {
    // The detail is measured against the untouched picture.
    color += (color - blurSmall(v_uv)) * u_sharpen * 1.2;
  }

  // The tone: brightness, contrast and then the shadow and highlight
  // curve. The export folds the three of them into one curve.
  color += u_brightness;
  color = (color - 0.5) * (1.0 + u_contrast) + 0.5;
  color = clamp(color, 0.0, 1.0);
  color = vec3(tone(color.r), tone(color.g), tone(color.b));

  // The saturation works on the colour around the luma. The coefficients
  // are the ones the video pipeline uses, so the export lands in the same
  // place.
  float l = dot(color, LUMA);
  color = mix(vec3(l), color, 1.0 + u_saturation);

  color.r *= 1.0 + u_temperature * 0.15;
  color.b *= 1.0 - u_temperature * 0.15;

  if (u_grain > 0.0) {
    float n = hash(floor(v_uv * u_resolution));
    color += (n - 0.5) * u_grain * 0.35;
  }

  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`

const UNIFORMS = [
  'u_texture',
  'u_texel',
  'u_resolution',
  'u_brightness',
  'u_contrast',
  'u_saturation',
  'u_temperature',
  'u_shadows',
  'u_highlights',
  'u_sharpen',
  'u_blur',
  'u_grain'
] as const

export class AdjustFilter {
  private canvas: HTMLCanvasElement
  private scratch: HTMLCanvasElement
  private scratchCtx: CanvasRenderingContext2D | null = null
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private texture: WebGLTexture | null = null
  private vao: WebGLVertexArrayObject | null = null
  private locations = new Map<string, WebGLUniformLocation | null>()
  private broken = false

  constructor() {
    this.canvas = document.createElement('canvas')
    this.scratch = document.createElement('canvas')
  }

  /** Whether the GPU filter can run in this environment. */
  get supported(): boolean {
    return this.setup() !== null
  }

  /**
   * Draws `source` through the filter and returns the adjusted picture.
   *
   * The source is scaled to `width`×`height` first, which is the size the
   * clip occupies in the composition — the export scales the source into
   * the frame before it adjusts it as well.
   */
  apply(
    source: CanvasImageSource,
    adjustments: ClipAdjustments,
    width: number,
    height: number
  ): HTMLCanvasElement | null {
    const gl = this.setup()
    if (!gl || !this.program || !this.texture || !this.vao) return null

    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))

    const scratchCtx = this.scratchContext()
    if (!scratchCtx) return null
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w
      this.scratch.height = h
    }
    scratchCtx.clearRect(0, 0, w, h)
    try {
      scratchCtx.drawImage(source, 0, 0, w, h)
    } catch {
      // The frame is not ready yet — leave the clip untouched this time.
      return null
    }

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }

    gl.viewport(0, 0, w, h)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // WebGL puts the first row of the picture at the bottom of the texture
    // unless it is told otherwise — without this the filtered picture comes
    // out upside down.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch)

    const loc = (name: string): WebGLUniformLocation | null =>
      this.locations.get(name) ?? null

    gl.uniform1i(loc('u_texture'), 0)
    gl.uniform2f(loc('u_texel'), 1 / w, 1 / h)
    gl.uniform2f(loc('u_resolution'), w, h)
    gl.uniform1f(loc('u_brightness'), adjustments.brightness)
    gl.uniform1f(loc('u_contrast'), adjustments.contrast)
    gl.uniform1f(loc('u_saturation'), adjustments.saturation)
    gl.uniform1f(loc('u_temperature'), adjustments.temperature)
    gl.uniform1f(loc('u_shadows'), adjustments.shadows)
    gl.uniform1f(loc('u_highlights'), adjustments.highlights)
    gl.uniform1f(loc('u_sharpen'), adjustments.sharpen)
    gl.uniform1f(loc('u_blur'), adjustments.blur)
    gl.uniform1f(loc('u_grain'), adjustments.grain)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)

    return this.canvas
  }

  dispose(): void {
    const gl = this.gl
    if (!gl) return
    if (this.texture) gl.deleteTexture(this.texture)
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    this.gl = null
    this.program = null
    this.texture = null
    this.vao = null
  }

  private setup(): WebGL2RenderingContext | null {
    if (this.gl) return this.gl
    if (this.broken) return null

    let gl: WebGL2RenderingContext | null = null
    try {
      gl = this.canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        // The result is read back with drawImage, which needs the buffer to
        // still be there when the compositor comes around.
        preserveDrawingBuffer: true
      })
    } catch {
      gl = null
    }
    if (!gl) {
      this.broken = true
      return null
    }

    const program = linkProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER)
    if (!program) {
      this.broken = true
      return null
    }
    this.program = program

    for (const name of UNIFORMS) {
      this.locations.set(name, gl.getUniformLocation(program, name))
    }

    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) {
      this.broken = true
      return null
    }
    this.vao = vao
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    // A single triangle that covers the whole viewport.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    const texture = gl.createTexture()
    if (!texture) {
      this.broken = true
      return null
    }
    this.texture = texture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    this.gl = gl
    return gl
  }

  private scratchContext(): CanvasRenderingContext2D | null {
    if (!this.scratchCtx) {
      this.scratchCtx = this.scratch.getContext('2d', { alpha: false })
    }
    return this.scratchCtx
  }
}

/** Compiles a program and reports what went wrong on the console. */
function linkProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string
): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vertex || !fragment) return null

  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[clipforge] 调整滤镜编译失败:', gl.getProgramInfoLog(program))
    return null
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('[clipforge] 调整滤镜编译失败:', gl.getShaderInfoLog(shader))
    return null
  }
  return shader
}

/**
 * The part of the adjustments a plain 2D canvas can still do.
 *
 * Used when the GPU filter is unavailable — without WebGL the picture would
 * otherwise ignore the adjustments completely.
 */
export function cssFilterFor(adjustments: ClipAdjustments): string {
  const parts: string[] = []
  if (Math.abs(adjustments.brightness) > 0.001) {
    parts.push(`brightness(${(1 + adjustments.brightness).toFixed(3)})`)
  }
  if (Math.abs(adjustments.contrast) > 0.001) {
    parts.push(`contrast(${(1 + adjustments.contrast).toFixed(3)})`)
  }
  if (Math.abs(adjustments.saturation) > 0.001) {
    parts.push(`saturate(${(1 + adjustments.saturation).toFixed(3)})`)
  }
  if (adjustments.blur > 0.001) {
    parts.push(`blur(${(adjustments.blur * 10).toFixed(2)}px)`)
  }
  return parts.join(' ')
}
