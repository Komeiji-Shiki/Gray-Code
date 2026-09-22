import { createSpriteRenderer } from './spriteRenderer';
import { createLive2dRenderer } from './live2dRenderer';
import type { PetRenderer } from './protocol';

const canvas = document.querySelector('canvas')!;
let renderer: PetRenderer | undefined, sessionId = '', sequence = 0;
let expiration: ReturnType<typeof setTimeout> | undefined;
const post = (value: Record<string, unknown>) => parent.postMessage({ type: 'graycode.pet.renderer', sessionId, ...value }, '*');
window.addEventListener('message', async event => {
  if (event.source !== parent || event.data?.type !== 'graycode.pet.host') return;
  const input = event.data;
  if (input.action === 'load') {
    if (sessionId) return;
    sessionId = input.sessionId;
    const loading = ++sequence;
    try {
      const loaded = await (input.payload.resource.kind === 'sprite' ? createSpriteRenderer : createLive2dRenderer)(canvas, input.payload);
      if (loading !== sequence) { loaded.destroy(); return; }
      renderer = loaded;
      renderer.resize(innerWidth, innerHeight); post({ event: 'ready', parameters: renderer.parameters });
    } catch (error) { if(loading === sequence)post({ event: 'failed', error: (error as Error).message }); }
    return;
  }
  if (input.sessionId !== sessionId || !renderer) return;
  if (input.action === 'resize') { renderer.resize(input.width, input.height); return; }
  if (input.action === 'apply') {
    const request = ++sequence; clearTimeout(expiration);
    if (input.command && !input.command.expiresAt && Number.isFinite(input.command.durationMs)) expiration = setTimeout(() => { if (request === sequence) void renderer?.apply(null, input.configuration); }, input.command.durationMs);
    try { await renderer.apply(input.command, input.configuration); if (request === sequence) post({ event: 'applied', requestId: input.command?.requestId, success: true }); }
    catch (error) { if (request === sequence) post({ event: 'applied', requestId: input.command?.requestId, success: false, error: (error as Error).message }); }
  }
});
window.addEventListener('pagehide', () => { sequence++; clearTimeout(expiration); renderer?.destroy(); renderer = undefined; });
parent.postMessage({ type: 'graycode.pet.renderer', event: 'connected' }, '*');
