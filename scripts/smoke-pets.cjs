const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { buildSync } = require('esbuild');

module.exports = async function smokePets({ window, rpc, ui, evaluate, until, root, output, configId, setReply, getRequests }) {
  const module = { exports: {} };
  const format = buildSync({
    entryPoints: [path.join(root, 'shared/petFormat.ts')], bundle: true, write: false, format: 'cjs',
  }).outputFiles[0].text;
  new Function('module', 'exports', format)(module, module.exports);
  const { live2dReferences, petAssetPath, petAnimations } = module.exports;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const imported = [];
  const results = [];
  const checkpoint = active => fs.writeFile(path.join(output, 'pets-progress.json'),
    JSON.stringify({ models: results, ...(active ? { active } : {}) }, null, 2));
  const paths = (process.env.GRAYCODE_PET_MODELS ?? '').split(';').filter(Boolean);
  const corePath = process.env.GRAYCODE_PET_CORE;
  const status = () => rpc('pets.status');
  async function configure(values) {
    const prior = await status();
    return rpc('pets.configure', { configuration: { ...prior.configuration, ...values }, revision: prior.revision });
  }
  const command = async input => {
    const result = await rpc('pets.command', { command: input });
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.equal(result.applied, true, JSON.stringify(result));
    return result;
  };
  function allFrames(frame) { return [frame, ...frame.frames.flatMap(allFrames)]; }
  const frame = () => allFrames(window.webContents.mainFrame).find(frame => frame.url.endsWith('/pet-renderer.html'));
  await evaluate(`window.__petSmokeDiagnostics = {};
    window.addEventListener('message', event => {
      if (event.data?.type === 'graycode.pet.renderer' && event.data.event === 'diagnostics')
        window.__petSmokeDiagnostics[event.data.requestId] = event.data.data;
    }); undefined`);
  async function rendererMessage(action, fields = {}) {
    const target = await until(frame, 'pet sandbox iframe');
    return target.executeJavaScript(`window.dispatchEvent(new MessageEvent('message', {
      source: parent, data: { type: 'graycode.pet.host', sessionId: document.querySelector('canvas').dataset.session,
        action: ${JSON.stringify(action)}, ...${JSON.stringify(fields)} }
    })); undefined`, true);
  }
  async function inspect(gpu = false) {
    const requestId = randomUUID();
    await rendererMessage('inspect', { requestId, gpu });
    return until(() => evaluate(`window.__petSmokeDiagnostics[${JSON.stringify(requestId)}]`), 'pet renderer diagnostics');
  }
  async function screenshot(name) {
    const target = await until(frame, 'pet screenshot frame');
    // WebGL 绘制结束后，离屏 compositor 还未必提交该帧；等两次浏览器帧，不推进模型本身。
    await target.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const bounds = await evaluate(`(() => {
      const box = document.querySelector('.pet-stage').getBoundingClientRect();
      return { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)),
        width: Math.max(1, Math.ceil(box.width)), height: Math.max(1, Math.ceil(box.height)) };
    })()`);
    const picture = (await window.webContents.capturePage(bounds)).toPNG();
    const destination = path.join(output, name + '.png');
    await fs.writeFile(destination, picture);
    return { picture, destination };
  }
  async function loadModel(manifest) {
    const bytes = await fs.readFile(manifest);
    const raw = JSON.parse(bytes.toString('utf8'));
    const entry = path.basename(manifest);
    const wanted = [...new Set([entry, ...live2dReferences(raw).map(reference => petAssetPath(entry, reference))])];
    const files = await Promise.all(wanted.map(async name => ({
      path: name, data: (await fs.readFile(path.join(path.dirname(manifest), name))).toString('base64'),
    })));
    const resource = await rpc('pets.import', {
      entry, files, name: path.basename(manifest, '.model3.json'), source: '授权本机样例烟测',
    });
    imported.push(resource);
    return resource;
  }
  async function loadSprite() {
    const cells = [];
    for (let row = 0; row < 11; row++) for (let column = 0; column < 8; column++) {
      const needed = row >= 9 || column < petAnimations[row]?.frames || row === 0 && column === 6;
      if (!needed) continue;
      cells.push('<rect x="' + (column * 192 + 45) + '" y="' + (row * 208 + 40) +
        '" width="' + (60 + column * 3) + '" height="118" fill="hsl(' + (row * 27 + column * 19) + ',65%,60%)"/>');
    }
    const atlas = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="2288">' +
      cells.join('') + '</svg>')).png().toBuffer();
    const resource = await rpc('pets.import', {
      entry: 'pet.json', files: [
        { path: 'pet.json', data: Buffer.from(JSON.stringify({
          spriteVersionNumber: 2, spritesheetPath: 'atlas.png', displayName: '真实精灵图烟测',
        })).toString('base64') },
        { path: 'atlas.png', data: atlas.toString('base64') },
      ],
    });
    imported.push(resource);
    return resource;
  }
  async function ready(resource) {
    await configure({ resourceId: resource.id, visible: true, surface: 'app', scale: 2, stopped: false,
      reducedMotion: false, taskAnimations: false, mappings: {}, followPointer: false, soundEnabled: false, speechEnabled: false });
    await until(async () => {
      const snapshot = await status();
      if (snapshot.state.phase === 'failed') throw new Error(snapshot.state.error ?? 'Pet renderer failed to load.');
      return snapshot.state.phase === 'ready';
    }, 'pet ready: ' + resource.name, 30000);
    await until(() => evaluate('document.querySelector(".pet-player")?.dataset.ready === "true"'), 'pet player ready flag');
  }
  async function waitRun(runId) {
    await until(async () => {
      const run = (await rpc('runs.list')).find(run => run.id === runId);
      if (run?.status === 'failed') throw new Error(run.error ?? 'Pet smoke model run failed.');
      return run?.status === 'completed';
    }, 'pet model run completed');
  }
  try {
    if (paths.length) {
      assert(corePath, 'GRAYCODE_PET_CORE is required for Live2D model smoke.');
      await rpc('pets.runtime.import', { name: path.basename(corePath), data: (await fs.readFile(corePath)).toString('base64') });
      for (const manifest of paths) await loadModel(manifest);
    } else await loadSprite();

    for (const resource of imported) {
      await ready(resource);
      const item = { name: resource.name, kind: resource.kind, actions: resource.actions.length,
        expressions: resource.expressions.length, screenshots: {} };
      const baseline = await inspect();
      assert.equal(baseline.gpu, undefined, 'Regular inspection must omit GPU diagnostics.');
      const beforeIdle = await frame().executeJavaScript('Number(document.querySelector("canvas").dataset.frames)');
      await sleep(350);
      const afterIdle = await frame().executeJavaScript('Number(document.querySelector("canvas").dataset.frames)');
      assert(afterIdle > beforeIdle, 'Idle frames must continue without a command.');
      item.idleFrames = { before: beforeIdle, after: afterIdle };
      item.screenshots.idle = (await screenshot(resource.name + '-idle')).destination;
      const motion = resource.actions.find(action => action.group === 'TapBody') ?? resource.actions.find(action => action.id === 'waving') ?? resource.actions[0];
      assert(motion, 'A motion is required.');
      await command({ action: 'play', id: motion.id, durationMs: 8000 });
      const motionRequest = (await status()).state.channels.motion.requestId;
      const expression = resource.expressions[0];
      if (expression) {
        await command({ action: 'expression', id: expression.id, durationMs: 900 });
        assert.equal((await status()).state.channels.motion.requestId, motionRequest, 'Expression must retain the active motion.');
      }
      await command({ action: 'look', angle: 90, durationMs: 1500 });
      assert.equal((await status()).state.channels.motion.requestId, motionRequest, 'Gaze must retain the active motion.');
      const parameters = (await status()).state.parameters;
      const parameter = parameters.find(parameter => parameter.id === 'ParamAngleZ') ?? parameters[0];
      const value = parameter ? parameter.default + (parameter.max - parameter.default) * 0.3 : undefined;
      if (parameter) {
        await command({ action: 'parameters', parameters: { [parameter.id]: value }, durationMs: 5000 });
        assert.equal((await status()).state.channels.motion.requestId, motionRequest, 'Parameter control must retain the active motion.');
      }
      const layered = await inspect();
      assert.equal(layered.channels.motion.id, motion.id);
      if (expression) assert.equal(layered.channels.expression.id, expression.id);
      if (parameter) assert(Math.abs(layered.parameters[parameter.id] - value) < 0.00001, 'Override must reach the drawn Core parameters.');
      if (resource.kind === 'live2d') assert(layered.focus.x > 0.9, 'Gaze must reach the focus controller.');
      item.layers = { motion: layered.channels.motion.id, expression: layered.channels.expression?.id,
        gaze: layered.focus, parameter: parameter ? { id: parameter.id, expected: value, actual: layered.parameters[parameter.id] } : undefined };
      item.screenshots.layered = (await screenshot(resource.name + '-layered')).destination;
      if (expression) {
        await until(async () => !(await status()).state.channels.expression, 'expression channel expiry');
        assert.equal((await status()).state.channels.motion.requestId, motionRequest, 'Expiring expression must keep motion.');
        item.independentExpiry = true;
      }
      await checkpoint(item);

      const annotated = await rpc('pets.resource.annotate', {
        id: resource.id, actions: [{ id: motion.id, description: '开心挥手，测试语义标注' }],
        expressions: expression ? [{ id: expression.id, description: '温柔微笑，测试语义标注' }] : [],
        hitAreas: (resource.hitAreas ?? []).map(area => ({ id: area.id, motion: motion.id })),
      });
      assert.equal(annotated.actions.find(action => action.id === motion.id).description, '开心挥手，测试语义标注');
      item.semanticDescriptions = true;
      const combined = await command({ action: 'set', motion: motion.id, ...(expression ? { expression: expression.id } : {}),
        angle: 45, ...(parameter ? { parameters: { [parameter.id]: value } } : {}), durationMs: 4000 });
      const together = await inspect();
      assert(Object.values(together.channels).every(channel => channel.requestId === combined.command.requestId));
      item.combinationApplied = true;
      await checkpoint(item);

      await configure({ taskAnimations: true, mappings: { idle: resource.kind === 'sprite' ? 'idle' :
        (resource.actions.find(action => action.group?.toLowerCase() === 'idle') ?? motion).id } });
      await command({ action: 'cancel' });
      await until(async () => (await status()).state.channels.motion?.source === 'task', 'cancel releases task motion immediately');
      assert(Object.values((await status()).state.channels).every(command => command.source === 'task'));
      item.cancelReleasesControl = true;
      await configure({ stopped: true });
      await until(() => frame().executeJavaScript('document.querySelector("canvas").dataset.stopped === "true"'), 'renderer manual stop');
      const stoppedFrame = await frame().executeJavaScript('Number(document.querySelector("canvas").dataset.frames)');
      await sleep(250);
      const afterStop = await frame().executeJavaScript('Number(document.querySelector("canvas").dataset.frames)');
      assert.equal(afterStop, stoppedFrame, 'A manual stop must stop refreshing.');
      await command({ action: 'resume' });
      await until(async () => !(await status()).configuration.stopped, 'manual resume restores user stop');
      await configure({ taskAnimations: false });
      item.manualStopResume = true;
      await checkpoint(item);

      if (resource.kind === 'live2d') {
        await command({ action: 'cancel' });
        const lip = (await inspect()).lipSyncIds;
        if (lip.length) {
          await rendererMessage('mouth', { value: 0.8 });
          const speaking = await inspect();
          for (const id of lip) {
            const definition = parameters.find(parameter => parameter.id === id);
            assert(definition);
            const expected = definition.default + (definition.max - definition.default) * 0.8;
            assert(Math.abs(speaking.parameters[id] - expected) < 0.00001, 'LipSync must reach the declared parameter.');
          }
          await rendererMessage('mouth', { value: 0 });
          item.lipSync = lip;
        }
        const sourceBundle = JSON.parse((await fs.readFile(paths[imported.indexOf(resource)])).toString('utf8'));
        const sounded = Object.entries(sourceBundle.FileReferences.Motions ?? {}).flatMap(([group, motions]) =>
          motions.flatMap((motion, index) => motion.Sound ? [{ id: group + '/' + index }] : []));
        if (sounded.length) {
          await configure({ soundEnabled: true });
          await command({ action: 'play', id: sounded[0].id, durationMs: 8000 });
          const audio = await until(async () => {
            const audio = (await inspect()).audio;
            if (audio?.error) throw new Error('Model motion audio failed: ' + audio.error);
            return audio && !audio.paused && audio.currentTime > 0.05 ? audio : false;
          }, 'local motion audio plays', 5000);
          item.motionAudio = audio;
          await configure({ soundEnabled: false });
        }

        const colorParameters = {};
        for (const id of ['ParamSphereOn', 'ParamSphereMultiplyColor', 'ParamSphereScreenColor', 'ParamAllColor1', 'ParamAllColor2']) {
          const definition = parameters.find(parameter => parameter.id === id);
          if (definition) colorParameters[id] = id === 'ParamSphereOn' ? definition.max :
            definition.default + (definition.max - definition.default) * 0.7;
        }
        if (Object.keys(colorParameters).length) {
          await command({ action: 'cancel' });
          await command({ action: 'parameters', parameters: colorParameters, durationMs: 120000 });
          const colored = await inspect(true);
          const gpu = colored.gpu;
          assert(gpu.colorSupport, 'Core color arrays must be supported.');
          assert(gpu.coloredDrawableCount > 0, 'Color parameters must change real drawables.');
          assert(gpu.coloredDrawablesInFrame > 0, 'Changed color drawables must reach the renderer.');
          assert(gpu.shaderUniforms.length > 0, 'Changed colors must reach a real shader program.');
          for (const sample of gpu.shaderUniforms) {
            for (const [actual, expected] of [[sample.multiply, sample.expectedMultiply], [sample.screen, sample.expectedScreen]]) {
              assert.equal(actual.length, expected.length);
              assert(actual.every((value, index) => Math.abs(value - expected[index]) < 0.00001),
                'GPU multiply and screen uniforms must match the same drawable in Core.');
            }
          }
          await fs.writeFile(path.join(output, resource.name + '-gpu-comparison.json'), JSON.stringify(gpu, null, 2));
          item.colors = { diagnostics: gpu, controlledParameters: colorParameters };
          item.screenshots.colors = (await screenshot(resource.name + '-colors')).destination;
          await checkpoint(item);
          if (gpu.blendShapeParameterCount > 0) {
            const blend = gpu.blendShapeParameters[0];
            const definition = parameters.find(parameter => parameter.id === blend.id);
            const weight = definition.default + (definition.max - definition.default) * 0.8;
            await command({ action: 'parameters', parameters: { ...colorParameters, [blend.id]: weight }, durationMs: 120000 });
            const shaped = await inspect();
            assert(Math.abs(shaped.parameters[blend.id] - weight) < 0.00001, 'BlendShape weight must reach Core.');
            item.blendShape = { count: gpu.blendShapeParameterCount, id: blend.id, weight };
          }
        }
      }

      if (setReply && getRequests) {
        await checkpoint(item);
        await command({ action: 'cancel' });
        const queryChat = await rpc('pets.chat.create', {});
        const queryStart = getRequests().length;
        setReply('查询完成。');
        const queryRun = await rpc('pets.chat.send', {
          conversationId: queryChat.id, configId, message: 'pet-query-smoke', streamId: 'pet-query-' + randomUUID(),
        });
        await waitRun(queryRun.runId);
        const toolMessage = getRequests().slice(queryStart).flatMap(request => request.messages).find(message => message.role === 'tool');
        assert(toolMessage, 'Query tool result must reach the real provider request.');
        const serialized = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content);
        assert(!serialized.includes('"sha256"') && !serialized.includes('"files"'), 'Pet query must not return asset files or hashes.');
        assert(serialized.includes('开心挥手'), 'The model must receive the motion description.');
        item.queryCharacters = serialized.length;
        const companion = await rpc('companion.save', { configuration: {
          enabled: true, name: '桌宠烟测陪伴', userName: '主人', tone: '保持简洁', petResourceId: resource.id,
        } });
        const before = getRequests().length;
        const tag = '<pet motion="' + motion.id + '"' + (expression ? ' expression="' + expression.id + '"' : '') + '/>';
        setReply('你好，主人。' + tag + '我在这里陪你。');
        const sent = await rpc('pets.chat.send', { conversationId: companion.conversationId, configId,
          message: '测试一次行内桌宠表达。', streamId: 'pet-inline-' + randomUUID() });
        await waitRun(sent.runId);
        assert.equal(getRequests().length - before, 1, 'Inline control must need only one provider request.');
        const history = await rpc('conversations.history', { id: companion.conversationId });
        assert(!JSON.stringify(history.messages).includes('<pet'), 'Inline tags must be removed from stored and displayed text.');
        await until(async () => (await status()).state.channels.motion?.id === motion.id, 'inline motion applied');
        const applied = await inspect();
        if (expression) assert.equal(applied.channels.expression.id, expression.id);
        item.inline = { runId: sent.runId, modelRequests: 1, tagsHidden: true };
        item.screenshots.inline = (await screenshot(resource.name + '-inline')).destination;
      }
      results.push(item);
      await checkpoint();
    }
    return { verified: ['real sandbox pet renderer', 'idle refresh', 'independent channels and expiry',
      'combined control acknowledgement', 'semantic descriptions', 'cancel release', 'manual stop and resume',
      ...(paths.length ? ['local Cubism Core', 'declared LipSync groups', 'model motion audio', 'GPU multiply and screen colors', 'Core BlendShape parameters'] : []),
      ...(setReply ? ['compact pet query through model requests', 'streamed inline pet directive'] : [])], models: results };
  } finally {
    await configure({ visible: false }).catch(() => {});
  }
};
