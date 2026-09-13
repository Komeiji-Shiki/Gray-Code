import { petAnimations } from '../../../../shared/petFormat';
import type { PetCommandInput } from '@graycode/contracts';
import type { PetRenderer, PetRenderPayload } from './protocol';

/** 图集坐标来自已验证的版本合同，不按图片外观猜测动画格。 */
export async function createSpriteRenderer(canvas: HTMLCanvasElement, payload: PetRenderPayload): Promise<PetRenderer> {
  const source = payload.resource.sprite!;
  const file = payload.bundle.files.find(file => file.path === source.atlas)!;
  const image = new Image(); image.src = `data:${payload.resource.files.find(file => file.path === source.atlas)!.mimeType};base64,${file.data}`;
  await image.decode();
  const context = canvas.getContext('2d')!;
  let command: PetCommandInput | null = null, stopped = false, reduced = false, frame = 0, started = performance.now(), animation = 0;
  function draw(now = performance.now()) {
    let row = 0, col = source.neutral ? 6 : 0;
    if (!stopped && command?.action === 'look' && command.angle !== null && command.angle !== undefined && source.version === 2) {
      const index = Math.round(command.angle / 22.5) % 16; row = 9 + Math.floor(index / 8); col = index % 8;
    } else if (!stopped && command?.action === 'play') {
      row = Math.max(0, petAnimations.findIndex(item => item.id === command!.id));
      col = reduced ? 0 : Math.floor((now - started) / 125) % petAnimations[row]!.frames;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / 192, canvas.height / 208);
    context.drawImage(image, col * 192, row * 208, 192, 208, (canvas.width - 192 * scale) / 2, (canvas.height - 208 * scale) / 2, 192 * scale, 208 * scale);
    canvas.dataset.row = String(row); canvas.dataset.column = String(col); canvas.dataset.frames = String(++frame);
  }
  function tick(now: number) { draw(now); animation = requestAnimationFrame(tick); }
  return { parameters: [],
    async apply(next, configuration) {
      cancelAnimationFrame(animation); command = next; stopped = configuration.stopped; reduced = configuration.reducedMotion; started = performance.now(); draw();
      if (!stopped && !reduced && command?.action === 'play') animation = requestAnimationFrame(tick);
    },
    resize(width, height) { canvas.width = width; canvas.height = height; draw(); },
    destroy() { cancelAnimationFrame(animation); image.src = ''; context.clearRect(0, 0, canvas.width, canvas.height); },
  };
}
