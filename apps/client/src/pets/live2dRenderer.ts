import { PET_CHANNELS, type PetChannel, type PetControls, type PetParameter } from '@graycode/contracts';
import { petAssetPath } from '../../../../shared/petFormat';
import type { PetRenderer, PetRenderPayload } from './protocol';

/** 此模块只在无宿主接口、无网络连接权限的独立页面中执行。 */
export async function createLive2dRenderer(canvas: HTMLCanvasElement, payload: PetRenderPayload): Promise<PetRenderer> {
  if (!payload.runtime) throw new Error('请先导入本地 Cubism Core 运行库。');
  const urls: string[] = [];
  const blob = (bytes: ArrayBuffer, type: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    urls.push(url);
    return url;
  };
  let pixi: import('pixi.js').Application | undefined;
  try {
    const script = document.createElement('script');
    script.src = blob(payload.runtime, 'text/javascript');
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('本地 Cubism Core 无法加载。'));
      document.head.append(script);
    });
    const PIXI = await import('pixi.js');
    const { Live2DModel, MotionPriority, config } = await import('./vendor/cubism4');
    const { installCubismCompatibility } = await import('./cubismCompatibility');
    config.sound = false;
    config.motionSync = false;
    config.preserveExpressionOnMotion = true;
    const files = new Map(payload.bundle.files.map(file => [file.path, file.bytes]));
    const assets = new Map(payload.bundle.files.map(file => [
      file.path, blob(file.bytes, payload.resource.files.find(meta => meta.path === file.path)!.mimeType),
    ]));
    const entry = files.get(payload.bundle.entry)!;
    const raw = JSON.parse(new TextDecoder().decode(entry));
    const resolve = (reference: string) => {
      const url = assets.get(petAssetPath(payload.bundle.entry, reference));
      if (!url) throw new Error('缺少模型资源：' + reference);
      return url;
    };
    const motionParameters = new Map<string, string[]>();
    const refs = raw.FileReferences;
    refs.Moc = resolve(refs.Moc);
    refs.Textures = refs.Textures.map(resolve);
    for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (refs[key]) refs[key] = resolve(refs[key]);
    for (const expression of refs.Expressions ?? []) expression.File = resolve(expression.File);
    for (const [group, motions] of Object.entries(refs.Motions ?? {}) as [string, { File: string; Sound?: string }[]][]) {
      for (const [index, motion] of motions.entries()) {
        const definition = JSON.parse(new TextDecoder().decode(files.get(petAssetPath(payload.bundle.entry, motion.File))!));
        motionParameters.set(group + '/' + index, definition.Curves
          .filter((curve: { Target: string }) => curve.Target === 'Parameter')
          .map((curve: { Id: string }) => curve.Id));
        motion.File = resolve(motion.File);
        if (motion.Sound) motion.Sound = resolve(motion.Sound);
      }
    }
    // 所有真实引用已改为本页创建的 Blob URL；库仍要求清单对象带有一个解析基址。
    raw.url = new URL('model.model3.json', location.href).href;
    pixi = new PIXI.Application({
      view: canvas, width: canvas.width || 300, height: canvas.height || 320, backgroundAlpha: 0,
      antialias: true, autoStart: false, sharedTicker: false,
    });
    // 待机动作经服务端映射和优先级控制，库只负责眨眼、呼吸和物理。
    let idleMotionGroup = '__graycode_controlled__';
    while (Object.prototype.hasOwnProperty.call(refs.Motions ?? {}, idleMotionGroup)) idleMotionGroup += '_';
    const model = await Live2DModel.from(raw, { autoInteract: false, autoUpdate: false, idleMotionGroup });
    pixi.stage.addChild(model);
    model.anchor.set(0.5);
    const internal = model.internalModel as import('./vendor/cubism4').Cubism4InternalModel;
    const compatibility = installCubismCompatibility(internal);
    const core = internal.coreModel;
    const actual = core.getModel().parameters;
    const parameters: PetParameter[] = Array.from(actual.ids, (id, index) => ({
      id, min: actual.minimumValues[index]!, max: actual.maximumValues[index]!, default: actual.defaultValues[index]!,
    }));
    const defaults = new Map(parameters.map(parameter => [parameter.id, parameter.default]));
    const versions: Record<PetChannel, number> = { motion: 0, expression: 0, look: 0, parameters: 0 };
    let controls: PetControls = {};
    let stopped = false;
    let reduced = false;
    let followPointer = true;
    let pointer: { x: number; y: number } | undefined;
    let mouthValue = 0;
    let animation = 0;
    let last = 0;
    let destroyed = false;
    let captureParameters = false;
    let sampledParameters: Record<string, number> = {};
    const lipSyncIds: string[] = raw.Groups?.find((group: { Name: string }) => group.Name === 'LipSync')?.Ids ?? ['ParamMouthOpenY'];
    const mouthParameters = parameters.filter(parameter => lipSyncIds.includes(parameter.id));

    const setParameters = () => {
      for (const [id, value] of Object.entries(controls.parameters?.parameters ?? {})) core.setParameterValueById(id, value);
      for (const parameter of mouthParameters) {
        if (mouthValue > 0 && controls.parameters?.parameters?.[parameter.id] === undefined) {
          core.setParameterValueById(parameter.id, parameter.default + mouthValue * (parameter.max - parameter.default));
        }
      }
      if (captureParameters) sampledParameters = Object.fromEntries(parameters.map(parameter => [
        parameter.id, core.getParameterValueById(parameter.id),
      ]));
    };
    internal.on('beforeModelUpdate', setParameters);

    function render(dt = 16) {
      if (destroyed) return;
      model.update(dt);
      pixi!.renderer.render(pixi!.stage);
      canvas.dataset.frames = String(Number(canvas.dataset.frames ?? 0) + 1);
    }
    function tick(now: number) {
      if (destroyed || stopped || reduced) return;
      const fps = controls.motion?.source && controls.motion.source !== 'task' || mouthValue > 0 ? 30 : 15;
      if (!last || now - last >= 1000 / fps) {
        render(last ? Math.min(250, now - last) : 16);
        last = now;
      }
      animation = requestAnimationFrame(tick);
    }
    function restart() {
      cancelAnimationFrame(animation);
      last = 0;
      if (!stopped && !reduced) animation = requestAnimationFrame(tick);
    }
    function neutral() {
      internal.motionManager.stopAllMotions();
      internal.motionManager.expressionManager?.resetExpression();
      internal.focusController.focus(0, 0, true);
      for (const parameter of parameters) core.setParameterValueById(parameter.id, parameter.default);
      core.saveParameters();
      internal.pose?.reset(core);
      mouthValue = 0;
      render();
    }
    function restoreMotion(command: PetControls['motion']) {
      internal.motionManager.stopAllMotions();
      for (const id of motionParameters.get(command?.id ?? '') ?? []) {
        const value = defaults.get(id);
        if (value !== undefined) core.setParameterValueById(id, value);
      }
      core.saveParameters();
    }
    function focus() {
      if (controls.look) {
        if (controls.look.angle !== undefined && controls.look.angle !== null) {
          const radians = controls.look.angle * Math.PI / 180;
          internal.focusController.focus(Math.sin(radians), Math.cos(radians), true);
        } else internal.focusController.focus(0, 0, true);
      } else if (pointer && followPointer) model.focus(pointer.x, pointer.y);
      else internal.focusController.focus(0, 0, true);
    }
    render();
    restart();
    return {
      parameters,
      async apply(command, configuration, next = {}) {
        const prior = controls;
        const wasStopped = stopped;
        stopped = configuration.stopped;
        reduced = configuration.reducedMotion;
        followPointer = configuration.followPointer !== false;
        config.sound = configuration.soundEnabled === true && !stopped;
        if (!config.sound) internal.motionManager.currentAudio?.pause();
        controls = next;
        if (stopped) {
          for (const channel of PET_CHANNELS) versions[channel]++;
          if (!wasStopped) neutral();
          restart();
          canvas.dataset.stopped = 'true';
          return;
        }
        canvas.dataset.stopped = 'false';
        if (command?.action === 'cancel' && !Object.keys(next).length) {
          for (const channel of PET_CHANNELS) versions[channel]++;
          neutral();
          restart();
          return;
        }
        const work: Promise<void>[] = [];
        for (const channel of PET_CHANNELS) {
          const before = prior[channel];
          const after = next[channel];
          if (before?.requestId === after?.requestId && !wasStopped) continue;
          const version = ++versions[channel];
          if (channel === 'motion') {
            if (!after) restoreMotion(before);
            else {
              const action = payload.resource.actions.find(action => action.id === after.id)!;
              // 库会拒绝重播正在播放的同一动作；只释放动作通道，保留表情、视线和参数。
              if (before?.id === after.id) internal.motionManager.stopAllMotions();
              work.push(model.motion(action.group!, action.index!, MotionPriority.FORCE).then(accepted => {
                if (version !== versions.motion || destroyed) return;
                if (!accepted) throw new Error('模型没有接受该动作。');
              }));
            }
          } else if (channel === 'expression') {
            if (!after || after.expression === null) internal.motionManager.expressionManager?.resetExpression();
            else {
              const manager = internal.motionManager.expressionManager;
              const index = manager?.getExpressionIndex(after.id!) ?? -1;
              // resetExpression 会保留上一次的 currentExpression，再次指定同一个表情时应恢复它。
              if (manager && index >= 0 && manager.expressions[index] === manager.currentExpression) manager.restoreExpression();
              else work.push(model.expression(after.id).then(accepted => {
                if (version !== versions.expression || destroyed) return;
                if (!accepted) throw new Error('模型没有接受该表情。');
              }));
            }
          } else if (channel === 'look') {
            if (after?.angle !== undefined && after.angle !== null &&
              !parameters.some(parameter => ['ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY'].includes(parameter.id))) {
              throw new Error('模型没有标准视线参数，请使用其实际参数单独控制。');
            }
            focus();
          }
        }
        await Promise.all(work);
        if (destroyed) return;
        render(reduced ? 1000 : 16);
        restart();
      },
      pointer(x, y, leave) {
        pointer = leave ? undefined : { x, y };
        if (!stopped && !controls.look) { focus(); if (reduced) render(); }
      },
      hitTest(x, y) { return model.hitTest(x, y); },
      mouth(value) {
        mouthValue = stopped ? 0 : Math.max(0, Math.min(1, value));
        if (reduced) render();
      },
      inspect(gpu = false) {
        captureParameters = true;
        let diagnostics: ReturnType<typeof compatibility.captureGpu> | undefined;
        try {
          if (gpu) diagnostics = compatibility.captureGpu(render);
          else render();
        } finally {
          captureParameters = false;
        }
        const audio = internal.motionManager.currentAudio;
        return {
          frames: Number(canvas.dataset.frames),
          channels: Object.fromEntries(Object.entries(controls).map(([channel, command]) => [
            channel, { requestId: command.requestId, ...(command.id ? { id: command.id } : {}) },
          ])),
          parameters: sampledParameters,
          focus: { x: internal.focusController.x, y: internal.focusController.y },
          lipSyncIds: mouthParameters.map(parameter => parameter.id),
          ...(diagnostics ? { gpu: diagnostics } : {}),
          ...(audio ? { audio: {
            paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime,
            ...(audio.error ? { error: audio.error.code } : {}),
          } } : {}),
        };
      },
      resize(width, height) {
        pixi!.renderer.resize(width, height);
        model.scale.set(1);
        model.scale.set(Math.min(width / model.width, height / model.height) * 0.96);
        model.position.set(width / 2, height / 2);
        render();
      },
      destroy() {
        destroyed = true;
        for (const channel of PET_CHANNELS) versions[channel]++;
        cancelAnimationFrame(animation);
        internal.off('beforeModelUpdate', setParameters);
        model.destroy();
        pixi!.destroy(false, { children: true, texture: true, baseTexture: true });
        urls.forEach(url => URL.revokeObjectURL(url));
      },
    };
  } catch (error) {
    pixi?.destroy(false, { children: true, texture: true, baseTexture: true });
    urls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
}
