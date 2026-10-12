import { createSpriteRenderer } from './spriteRenderer';
import { createLive2dRenderer } from './live2dRenderer';
import { PET_CHANNELS, PET_DEFAULT_DURATION_MS, type PetChannel, type PetCommand, type PetConfiguration, type PetControls } from '@graycode/contracts';
import type { PetRenderer, PetRenderPayload } from './protocol';

const canvas = document.querySelector('canvas')!;
let renderer: PetRenderer | undefined;
let sessionId = '';
let sequence = 0;
let controls: PetControls = {};
let configuration: PetConfiguration;
let queue = Promise.resolve();
const expirations = new Map<PetChannel, ReturnType<typeof setTimeout>>();
const post = (value: Record<string, unknown>) => parent.postMessage({ type: 'graycode.pet.renderer', sessionId, ...value }, '*');

type HostMessage = { type: 'graycode.pet.host'; sessionId: string } & (
  { action: 'load'; payload: PetRenderPayload } |
  { action: 'resize'; width: number; height: number } |
  { action: 'apply'; command?: PetCommand | null; configuration: PetConfiguration; controls?: PetControls } |
  { action: 'pointer'; x: number; y: number; leave: boolean } |
  { action: 'mouth'; value: number } |
  { action: 'inspect'; requestId: string; gpu?: boolean }
);

function previewControls(command: PetCommand | null | undefined): PetControls {
  if (!command || command.action === 'cancel' || command.action === 'resume') return {};
  const next = { ...controls };
  const value = { ...command, expiresAt: Date.now() + (command.durationMs ?? PET_DEFAULT_DURATION_MS) };
  if (command.action === 'play') next.motion = value;
  if (command.action === 'expression') next.expression = value;
  if (command.action === 'look') next.look = value;
  if (command.action === 'parameters') next.parameters = value;
  if (command.action === 'set') {
    if (command.motion !== undefined) next.motion = { ...value, action: 'play', id: command.motion };
    if (command.expression !== undefined) next.expression = {
      ...value, action: 'expression', ...(command.expression === null ? { expression: null } : { id: command.expression }),
    };
    if (command.angle !== undefined) next.look = { ...value, action: 'look' };
    if (command.parameters !== undefined) next.parameters = { ...value, action: 'parameters' };
  }
  return next;
}

function scheduleExpirations() {
  for (const timer of expirations.values()) clearTimeout(timer);
  expirations.clear();
  for (const channel of PET_CHANNELS) {
    const command = controls[channel];
    if (!command) continue;
    const timer = setTimeout(() => {
      if (!renderer || controls[channel]?.requestId !== command.requestId) return;
      const next = { ...controls };
      delete next[channel];
      controls = next;
      expirations.delete(channel);
      queue = queue.then(() => renderer?.apply(null, configuration, next)).then(() => {}).catch(error => {
        post({ event: 'failed', error: String(error) });
      });
    }, Math.max(0, command.expiresAt - Date.now()));
    expirations.set(channel, timer);
  }
}

window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.type !== 'graycode.pet.host') return;
  const input = event.data as HostMessage;
  if (input.action === 'load') {
    if (sessionId) return;
    sessionId = input.sessionId;
    canvas.dataset.session = sessionId;
    const loading = ++sequence;
    try {
      const loaded = await (input.payload.resource.kind === 'sprite' ? createSpriteRenderer : createLive2dRenderer)(canvas, input.payload);
      if (loading !== sequence) {
        loaded.destroy();
        return;
      }
      renderer = loaded;
      renderer.resize(innerWidth, innerHeight);
      post({ event: 'ready', parameters: renderer.parameters });
    } catch (error) {
      if (loading === sequence) post({ event: 'failed', error: (error as Error).message });
    }
    return;
  }
  if (input.sessionId !== sessionId || !renderer) return;
  if (input.action === 'resize') {
    renderer.resize(input.width, input.height);
    return;
  }
  if (input.action === 'pointer') {
    renderer.pointer?.(input.x, input.y, input.leave);
    return;
  }
  if (input.action === 'mouth') {
    renderer.mouth?.(input.value);
    return;
  }
  if (input.action === 'inspect') {
    post({ event: 'diagnostics', requestId: input.requestId, data: renderer.inspect?.(input.gpu) });
    return;
  }
  if (input.action === 'apply') {
    configuration = input.configuration;
    const previous = controls;
    const next = input.controls ?? (input.command === undefined ? controls : previewControls(input.command));
    controls = next;
    const requestIds = new Set<string>();
    if (input.command?.requestId) requestIds.add(input.command.requestId);
    for (const channel of PET_CHANNELS) {
      if (next[channel] && next[channel]!.requestId !== previous[channel]?.requestId) requestIds.add(next[channel]!.requestId);
    }
    const lifetime = sequence;
    scheduleExpirations();
    queue = queue.then(async () => {
      if (!renderer || lifetime !== sequence) return;
      try {
        await renderer.apply(input.command ?? null, input.configuration, next);
        if (lifetime === sequence) for (const requestId of requestIds) post({ event: 'applied', requestId, success: true });
      } catch (error) {
        if (lifetime === sequence) for (const requestId of requestIds) {
          post({ event: 'applied', requestId, success: false, error: (error as Error).message });
        }
      }
    });
  }
});

function pointer(event: PointerEvent) {
  const bounds = canvas.getBoundingClientRect();
  renderer?.pointer?.((event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height, event.type === 'pointerleave');
}
canvas.addEventListener('pointermove', pointer);
canvas.addEventListener('pointerleave', pointer);
canvas.addEventListener('click', event => {
  const bounds = canvas.getBoundingClientRect();
  const areas = renderer?.hitTest?.((event.clientX - bounds.left) * canvas.width / bounds.width,
    (event.clientY - bounds.top) * canvas.height / bounds.height) ?? [];
  if (areas.length) post({ event: 'hit', areas });
});
window.addEventListener('pagehide', () => {
  sequence++;
  for (const timer of expirations.values()) clearTimeout(timer);
  expirations.clear();
  renderer?.destroy();
  renderer = undefined;
  post({ event: 'closed' });
});
parent.postMessage({ type: 'graycode.pet.renderer', event: 'connected' }, '*');
