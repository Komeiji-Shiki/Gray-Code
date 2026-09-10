import { createGenerateImageRuntime } from './generate_imageRuntime';
import { legacyMediaHost } from './legacyHost';
const runtime = createGenerateImageRuntime(legacyMediaHost);
export const { onImageGenOutput, generateToolId, cancelImageGeneration, getActiveImageTasks, createGenerateImageTool, registerGenerateImage } = runtime;
export type { ImageGenOutputEvent } from './generate_imageRuntime';
