import { petAnimations } from '../../../../shared/petFormat';
import { PET_SPRITE_CELL_HEIGHT, PET_SPRITE_CELL_WIDTH, type PetControls } from '@graycode/contracts';
import type { PetRenderer, PetRenderPayload } from './protocol';

/** 图集坐标来自已验证的版本合同，不按图片外观猜测动画格。 */
export async function createSpriteRenderer(canvas: HTMLCanvasElement, payload: PetRenderPayload): Promise<PetRenderer> {
  const source = payload.resource.sprite!;
  const file = payload.bundle.files.find(file => file.path === source.atlas)!;
  const url = URL.createObjectURL(new Blob([file.bytes], {
    type: payload.resource.files.find(file => file.path === source.atlas)!.mimeType,
  }));
  const image = new Image();
  image.src = url;
  await image.decode();
  const context = canvas.getContext('2d')!;
  let controls: PetControls = {};
  let stopped = false;
  let reduced = false;
  let frame = 0;
  let started = performance.now();
  let animation = 0;
  function draw(now = performance.now()) {
    let row = 0, col = source.neutral ? 6 : 0;
    const angle = controls.look?.angle;
    if (!stopped && angle !== null && angle !== undefined && source.version === 2) {
      const index = Math.round(angle / 22.5) % 16;
      row = 9 + Math.floor(index / 8);
      col = index % 8;
    } else if (!stopped && !reduced || controls.motion && !stopped) {
      row = Math.max(0, petAnimations.findIndex(item => item.id === (controls.motion?.id ?? 'idle')));
      col = reduced ? 0 : Math.floor((now - started) / 125) % petAnimations[row]!.frames;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    const width = PET_SPRITE_CELL_WIDTH;
    const height = PET_SPRITE_CELL_HEIGHT;
    const scale = Math.min(canvas.width / width, canvas.height / height);
    context.drawImage(image, col * width, row * height, width, height,
      (canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2, width * scale, height * scale);
    canvas.dataset.row = String(row);
    canvas.dataset.column = String(col);
    canvas.dataset.frames = String(++frame);
  }
  let last = 0;
  function tick(now: number) {
    if (now - last >= 125) { draw(now); last = now; }
    animation = requestAnimationFrame(tick);
  }
  return {
    parameters: [],
    async apply(_command, configuration, next = {}) {
      cancelAnimationFrame(animation);
      if (controls.motion?.requestId !== next.motion?.requestId) started = performance.now();
      controls = next;
      stopped = configuration.stopped;
      reduced = configuration.reducedMotion;
      draw();
      canvas.dataset.stopped = String(stopped);
      if (!stopped && !reduced) animation = requestAnimationFrame(tick);
    },
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      draw();
    },
    inspect() {
      return {
        frames: frame,
        channels: Object.fromEntries(Object.entries(controls).map(([channel, command]) => [
          channel, { requestId: command.requestId, ...(command.id ? { id: command.id } : {}) },
        ])),
        parameters: {},
      };
    },
    destroy() {
      cancelAnimationFrame(animation);
      image.src = '';
      URL.revokeObjectURL(url);
      context.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
