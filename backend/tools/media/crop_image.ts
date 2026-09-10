import { createCropImageRuntime } from './crop_imageRuntime';
import { legacyMediaHost } from './legacyHost';
const runtime = createCropImageRuntime(legacyMediaHost);
export const { onCropImageOutput, cancelCropImage, createCropImageTool, registerCropImage } = runtime;
export type { CropImageOutputEvent } from './crop_imageRuntime';
