import type { PetParameter } from '@graycode/contracts';
import { petAssetPath } from '../../../../shared/petFormat';
import type { PetRenderer, PetRenderPayload } from './protocol';

/** 此模块只在无宿主接口、无网络连接权限的独立页面中执行。 */
export async function createLive2dRenderer(canvas: HTMLCanvasElement, payload: PetRenderPayload): Promise<PetRenderer> {
  if (!payload.runtime) throw new Error('请先导入本地 Cubism Core 运行库。');
  const urls: string[] = [];
  const blob = (data: string, type: string) => { const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type })); urls.push(url); return url; };
  let pixi: import('pixi.js').Application | undefined;
  try {
    const script = document.createElement('script'); script.src = blob(payload.runtime, 'text/javascript');
    await new Promise<void>((resolve, reject) => { script.onload = () => resolve(); script.onerror = () => reject(new Error('本地 Cubism Core 无法加载。')); document.head.append(script); });
    const PIXI = await import('pixi.js');
    const { Live2DModel, MotionPriority, config } = await import('./vendor/cubism4');
    config.sound = false;
    const assets = new Map(payload.bundle.files.map(file => [file.path, blob(file.data, payload.resource.files.find(meta => meta.path === file.path)!.mimeType)]));
    const entry = payload.bundle.files.find(file => file.path === payload.bundle.entry)!;
    const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(entry.data), char => char.charCodeAt(0))));
    const resolve = (reference: string) => { const url = assets.get(petAssetPath(payload.bundle.entry, reference)); if (!url) throw new Error(`缺少模型资源：${reference}`); return url; };
    const refs = raw.FileReferences;
    refs.Moc = resolve(refs.Moc); refs.Textures = refs.Textures.map(resolve);
    for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (refs[key]) refs[key] = resolve(refs[key]);
    for (const expression of refs.Expressions ?? []) expression.File = resolve(expression.File);
    for (const motions of Object.values(refs.Motions ?? {}) as any[][]) for (const motion of motions) { motion.File = resolve(motion.File); delete motion.Sound; }
    // 清单是对象时仍提供一个本页地址；所有真实引用已改为本页创建的 Blob URL。
    raw.url = new URL('model.model3.json', location.href).href;
    pixi = new PIXI.Application({ view: canvas, width: canvas.width || 300, height: canvas.height || 320, backgroundAlpha: 0, antialias: true, autoStart: false, sharedTicker: false });
    // 禁止库自行随机播放待机动作；实际动作都通过统一控制入口选择。
    let idleMotionGroup = '__graycode_controlled__';
    while (Object.prototype.hasOwnProperty.call(refs.Motions ?? {}, idleMotionGroup)) idleMotionGroup += '_';
    const model = await Live2DModel.from(raw, { autoInteract: false, autoUpdate: false, idleMotionGroup });
    pixi.stage.addChild(model); model.anchor.set(0.5);
    const internal = model.internalModel as import('./vendor/cubism4').Cubism4InternalModel;
    const core = internal.coreModel;
    const actual = core.getModel().parameters;
    const parameters: PetParameter[] = Array.from(actual.ids, (id, index) => ({ id, min: actual.minimumValues[index]!, max: actual.maximumValues[index]!, default: actual.defaultValues[index]! }));
    let overrides: Record<string, number> = {}, active = false, animation = 0, last = 0, destroyed = false, sequence = 0;
    const setParameters = () => { for (const [id, value] of Object.entries(overrides)) core.setParameterValueById(id, value); };
    internal.on('beforeModelUpdate', setParameters);
    function render(dt = 16) {
      if (destroyed) return;
      model.update(dt); pixi!.renderer.render(pixi!.stage);
      canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1);
    }
    function tick(now: number) { if (!active || destroyed) return; if (!last || now - last >= 1000 / 30) { render(last ? Math.min(100, now - last) : 16); last = now; } animation = requestAnimationFrame(tick); }
    function neutral() {
      internal.motionManager.stopAllMotions(); internal.motionManager.expressionManager?.resetExpression();
      internal.focusController.focus(0, 0, true); overrides = Object.fromEntries(parameters.map(parameter => [parameter.id, parameter.default]));
      // 包装器在 dt 为零时跳过核心更新；先恢复参数和姿势，再绘制一个真实静止帧。
      setParameters(); core.saveParameters(); internal.pose?.reset(core); render();
    }
    neutral();
    return { parameters,
      async apply(command, configuration) {
        const request = ++sequence; active = false; cancelAnimationFrame(animation); last = 0; neutral();
        if (!command || configuration.stopped || command.action === 'cancel' || command.action === 'resume') return;
        overrides = {};
        if (command.action === 'play') {
          const action = payload.resource.actions.find(action => action.id === command.id)!;
          const accepted = await model.motion(action.group!, action.index!, MotionPriority.FORCE);
          if (request !== sequence || destroyed) return;
          if (!accepted) throw new Error('模型没有接受该动作。');
          render();
        } else if (command.action === 'expression') {
          const accepted = await model.expression(command.id); if (request !== sequence || destroyed) return;
          if (!accepted) throw new Error('模型没有接受该表情。'); render(configuration.reducedMotion ? 1000 : 16);
        } else if (command.action === 'look') {
          if (command.angle !== null) {
            if (!parameters.some(parameter => ['ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY'].includes(parameter.id))) throw new Error('模型没有标准视线参数，请使用其实际参数单独控制。');
            const radians = command.angle! * Math.PI / 180; internal.focusController.focus(Math.sin(radians), Math.cos(radians), true);
          }
          render();
        } else if (command.action === 'parameters') { overrides = command.parameters ?? {}; render(); }
        if (!configuration.reducedMotion) { active = true; animation = requestAnimationFrame(tick); }
      },
      resize(width, height) {
        pixi!.renderer.resize(width, height); model.scale.set(1);
        model.scale.set(Math.min(width / model.width, height / model.height) * 0.96); model.position.set(width / 2, height / 2); render();
      },
      destroy() { destroyed = true; sequence++; active = false; cancelAnimationFrame(animation); internal.off('beforeModelUpdate', setParameters); model.destroy(); pixi!.destroy(false, { children: true, texture: true, baseTexture: true }); urls.forEach(url => URL.revokeObjectURL(url)); },
    };
  } catch (error) { pixi?.destroy(false, { children: true, texture: true, baseTexture: true }); urls.forEach(url => URL.revokeObjectURL(url)); throw error; }
}
