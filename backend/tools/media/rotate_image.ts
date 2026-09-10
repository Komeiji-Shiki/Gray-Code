import { createRotateImageRuntime } from './rotate_imageRuntime';
import { legacyMediaHost } from './legacyHost';
const runtime = createRotateImageRuntime(legacyMediaHost);
export const { onRotateImageOutput, cancelRotateImage, createRotateImageTool, registerRotateImage } = runtime;
export type { RotateImageOutputEvent } from './rotate_imageRuntime';
