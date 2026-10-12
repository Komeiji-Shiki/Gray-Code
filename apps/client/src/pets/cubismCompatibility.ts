import * as Cubism from './vendor/cubism4';
import type { Cubism4InternalModel } from './vendor/cubism4';

type Renderer = Cubism4InternalModel['renderer'];
type CoreModel = Cubism4InternalModel['coreModel'];
type ShaderArguments = [
  renderer: Renderer, texture: WebGLTexture | null, vertexCount: number,
  vertices: Float32Array, indices: Uint16Array, uvs: Float32Array, buffers: Renderer['_bufferData'],
  opacity: number, blendMode: number, baseColor: ReturnType<Renderer['getModelColor']>,
  premultipliedAlpha: boolean, matrix: ReturnType<Renderer['getMvpMatrix']>, invertedMask: boolean,
];

interface LegacyShader {
  gl: WebGLRenderingContext;
  _shaderSets: Array<{ shaderProgram: WebGLProgram }>;
  setGl(gl: WebGLRenderingContext): void;
  setupShaderProgram(...args: ShaderArguments): void;
  loadShaderProgram(vertex: string, fragment: string): WebGLProgram | 0;
  releaseShaderProgram(): void;
}

// 发布文件实际导出了这些 Framework 类，但原包声明只公开包装器；这里描述已核对的扩展接口。
const runtime = Cubism as typeof Cubism & {
  CubismRenderer_WebGL: new () => Renderer;
  CubismShader_WebGL: new () => LegacyShader;
  fragmentShaderSrcPremultipliedAlpha: string;
  fragmentShaderSrcMaskPremultipliedAlpha: string;
  fragmentShaderSrcMaskInvertedPremultipliedAlpha: string;
};

interface ModernModel {
  parameters: { ids: string[]; types?: Int32Array; values: Float32Array };
  drawables: {
    count: number;
    multiplyColors?: Float32Array;
    screenColors?: Float32Array;
  };
}

interface UniformLocations {
  multiply: WebGLUniformLocation;
  screen: WebGLUniformLocation;
}

export interface CubismGpuDiagnostics {
  colorSupport: boolean;
  coloredDrawableCount: number;
  coloredDrawablesInFrame: number;
  maskDrawCalls: number;
  maskedDrawCalls: number;
  shaderUniforms: Array<{
    drawableIndex: number;
    multiply: number[];
    screen: number[];
    expectedMultiply: number[];
    expectedScreen: number[];
  }>;
  blendShapeParameterCount: number;
  blendShapeParameters: Array<{ id: string; value: number }>;
}

/** 预乘透明度的颜色公式与官方 CubismWebFramework 5-r.4 一致，掩码阶段继续只计算透明度。 */
// https://github.com/Live2D/CubismWebFramework/blob/5-r.4/src/rendering/cubismshader_webgl.ts
function coloredFragment(masked: boolean, inverted = false): string {
  return `
precision mediump float;
varying vec2 v_texCoord;
uniform vec4 u_baseColor;
uniform sampler2D s_texture0;
uniform vec3 u_graycodeMultiply;
uniform vec3 u_graycodeScreen;
${masked ? 'varying vec4 v_clipPos; uniform sampler2D s_texture1; uniform vec4 u_channelFlag;' : ''}
void main() {
  vec4 texColor = texture2D(s_texture0, v_texCoord);
  texColor.rgb *= u_graycodeMultiply;
  texColor.rgb = (texColor.rgb + u_graycodeScreen * texColor.a) - texColor.rgb * u_graycodeScreen;
  vec4 color = texColor * u_baseColor;
  ${masked ? `
  vec4 mask = (1.0 - texture2D(s_texture1, v_clipPos.xy / v_clipPos.w)) * u_channelFlag;
  float maskValue = dot(mask, vec4(1.0));
  color *= ${inverted ? '(1.0 - maskValue)' : 'maskValue'};` : ''}
  gl_FragColor = color;
}`;
}

const fragments = new Map([
  [runtime.fragmentShaderSrcPremultipliedAlpha, coloredFragment(false)],
  [runtime.fragmentShaderSrcMaskPremultipliedAlpha, coloredFragment(true)],
  [runtime.fragmentShaderSrcMaskInvertedPremultipliedAlpha, coloredFragment(true, true)],
]);

class ColorShader extends runtime.CubismShader_WebGL {
  private readonly uniforms = new Map<WebGLProgram, UniformLocations>();
  private drawableIndex = 0;
  capturedUniforms?: Map<WebGLProgram, CubismGpuDiagnostics['shaderUniforms'][number]>;

  constructor(private readonly model: ModernModel) { super(); }

  override loadShaderProgram(vertex: string, fragment: string): WebGLProgram | 0 {
    const program = super.loadShaderProgram(vertex, fragments.get(fragment) ?? fragment);
    if (!program) throw new Error('Cubism 颜色着色器无法编译或链接。');
    return program;
  }

  override setGl(gl: WebGLRenderingContext): void {
    if (this.gl) this.releaseShaderProgram();
    this.uniforms.clear();
    super.setGl(gl);
  }

  selectDrawable(index: number): void { this.drawableIndex = index; }

  override setupShaderProgram(...args: ShaderArguments): void {
    super.setupShaderProgram(...args);
    const [renderer, , , , , , , , blendMode, , , , inverted] = args;
    if (renderer.getClippingContextBufferForMask()) return;
    const offset = renderer.getClippingContextBufferForDraw() ? inverted ? 2 : 1 : 0;
    const program = this._shaderSets[1 + blendMode * 3 + offset]!.shaderProgram;
    let locations = this.uniforms.get(program);
    if (!locations) {
      const multiply = this.gl.getUniformLocation(program, 'u_graycodeMultiply');
      const screen = this.gl.getUniformLocation(program, 'u_graycodeScreen');
      if (!multiply || !screen) throw new Error('Cubism 颜色着色器缺少颜色参数。');
      locations = { multiply, screen };
      this.uniforms.set(program, locations);
    }
    const index = this.drawableIndex * 4;
    const multiply = this.model.drawables.multiplyColors;
    const screen = this.model.drawables.screenColors;
    this.gl.uniform3f(locations.multiply, multiply?.[index] ?? 1, multiply?.[index + 1] ?? 1, multiply?.[index + 2] ?? 1);
    this.gl.uniform3f(locations.screen, screen?.[index] ?? 0, screen?.[index + 1] ?? 0, screen?.[index + 2] ?? 0);
    // 冒烟显式采集时，每种实际使用的着色程序只读回一个有颜色变化的 drawable。
    if (this.capturedUniforms && !this.capturedUniforms.has(program) && hasColor(this.model, this.drawableIndex)) {
      this.capturedUniforms.set(program, {
        drawableIndex: this.drawableIndex,
        multiply: Array.from(this.gl.getUniform(program, locations.multiply) as Float32Array),
        screen: Array.from(this.gl.getUniform(program, locations.screen) as Float32Array),
        expectedMultiply: [multiply?.[index] ?? 1, multiply?.[index + 1] ?? 1, multiply?.[index + 2] ?? 1],
        expectedScreen: [screen?.[index] ?? 0, screen?.[index + 1] ?? 0, screen?.[index + 2] ?? 0],
      });
    }
  }
}

class ColorRenderer extends runtime.CubismRenderer_WebGL {
  readonly shader: ColorShader;
  capturedFrame?: Pick<CubismGpuDiagnostics, 'coloredDrawablesInFrame' | 'maskDrawCalls' | 'maskedDrawCalls'>;
  private readonly indices = new WeakMap<Float32Array, number>();

  constructor(core: CoreModel, readonly model: ModernModel) {
    super();
    this.initialize(core);
    this.shader = new ColorShader(model);
    for (let index = 0; index < core.getDrawableCount(); index++) this.indices.set(core.getDrawableVertices(index), index);
  }

  override startUp(gl: WebGLRenderingContext): void {
    super.startUp(gl);
    this.shader.setGl(gl);
  }

  override drawMesh(...args: Parameters<Renderer['drawMesh']>): void {
    const [texture, count, vertexCount, indices, vertices, uvs, opacity, blendMode, inverted] = args;
    const drawableIndex = this.indices.get(vertices)!;
    this.shader.selectDrawable(drawableIndex);
    const gl = this.gl;
    if (this.isCulling()) gl.enable(gl.CULL_FACE);
    else gl.disable(gl.CULL_FACE);
    gl.frontFace(gl.CCW);
    const base = this.getModelColor();
    const capture = this.capturedFrame;
    if (this.getClippingContextBufferForMask()) {
      if (capture) capture.maskDrawCalls++;
    } else {
      if (capture) {
        if (this.getClippingContextBufferForDraw()) capture.maskedDrawCalls++;
        if (hasColor(this.model, drawableIndex)) capture.coloredDrawablesInFrame++;
      }
      base.A *= opacity;
      if (this.isPremultipliedAlpha()) {
        base.R *= base.A;
        base.G *= base.A;
        base.B *= base.A;
      }
    }
    this.shader.setupShaderProgram(this, this._textures[texture] ?? null, vertexCount, vertices, indices, uvs,
      this._bufferData, opacity, blendMode, base, this.isPremultipliedAlpha(), this.getMvpMatrix(), inverted);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    gl.useProgram(null);
    this.setClippingContextBufferForDraw(null);
    this.setClippingContextBufferForMask(null);
  }

  override release(): void {
    this.shader.releaseShaderProgram();
    super.release();
  }
}

function hasColor(model: ModernModel, index: number): boolean {
  const multiply = model.drawables.multiplyColors;
  const screen = model.drawables.screenColors;
  for (let channel = 0; channel < 3; channel++) {
    if (Math.abs((multiply?.[index * 4 + channel] ?? 1) - 1) > 0.000001
      || Math.abs(screen?.[index * 4 + channel] ?? 0) > 0.000001) return true;
  }
  return false;
}

/** 每个播放器实例拥有自己的着色器，避免修改第三方发布文件和全局 singleton。 */
export function installCubismCompatibility(internal: Cubism4InternalModel): {
  captureGpu(draw: () => void): CubismGpuDiagnostics;
} {
  const model = internal.coreModel.getModel() as unknown as ModernModel;
  const previous = internal.renderer;
  const renderer = new ColorRenderer(internal.coreModel, model);
  const color = previous.getModelColor();
  renderer.setModelColor(color.R, color.G, color.B, color.A);
  renderer.setIsPremultipliedAlpha(previous.isPremultipliedAlpha());
  renderer.setAnisotropy(previous.getAnisotropy());
  for (const [index, texture] of Object.entries(previous.getBindedTextures())) renderer.bindTexture(Number(index), texture);
  if (previous.gl) renderer.startUp(previous.gl);
  internal.renderer = renderer;
  previous.release();
  return {
    captureGpu(draw) {
      const frame = { coloredDrawablesInFrame: 0, maskDrawCalls: 0, maskedDrawCalls: 0 };
      const uniforms = new Map<WebGLProgram, CubismGpuDiagnostics['shaderUniforms'][number]>();
      renderer.capturedFrame = frame;
      renderer.shader.capturedUniforms = uniforms;
      try {
        draw();
        let coloredDrawableCount = 0;
        for (let index = 0; index < model.drawables.count; index++) {
          if (hasColor(model, index)) coloredDrawableCount++;
        }
        const blendShapeParameters: CubismGpuDiagnostics['blendShapeParameters'] = [];
        let blendShapeParameterCount = 0;
        // Core 4.2+ 已将 BlendShape 作为标准参数更新，类型 1 仅用于确认真实模型含有该能力。
        model.parameters.types?.forEach((type, index) => {
          if (type !== 1) return;
          blendShapeParameterCount++;
          if (blendShapeParameters.length < 16) blendShapeParameters.push({
            id: model.parameters.ids[index]!, value: model.parameters.values[index]!,
          });
        });
        return {
          colorSupport: !!model.drawables.multiplyColors && !!model.drawables.screenColors,
          coloredDrawableCount,
          ...frame,
          shaderUniforms: [...uniforms.values()],
          blendShapeParameterCount,
          blendShapeParameters,
        };
      } finally {
        // 采集只覆盖请求中的这次绘制，正常帧不遍历颜色或读回 GPU 状态。
        renderer.capturedFrame = undefined;
        renderer.shader.capturedUniforms = undefined;
      }
    },
  };
}
