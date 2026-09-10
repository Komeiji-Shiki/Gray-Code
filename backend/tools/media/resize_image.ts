import { createResizeImageRuntime } from './resize_imageRuntime';
import { legacyMediaHost } from './legacyHost';
const runtime = createResizeImageRuntime(legacyMediaHost);
export const { onResizeImageOutput, cancelResizeImage, createResizeImageTool, registerResizeImage } = runtime;
export type { ResizeImageOutputEvent } from './resize_imageRuntime';
