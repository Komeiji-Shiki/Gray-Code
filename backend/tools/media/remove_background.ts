import { createRemoveBackgroundRuntime } from './remove_backgroundRuntime';
import { legacyMediaHost } from './legacyHost';
const runtime = createRemoveBackgroundRuntime(legacyMediaHost);
export const { onRemoveBgOutput, cancelRemoveBackground, createRemoveBackgroundTool, registerRemoveBackground } = runtime;
export type { RemoveBgOutputEvent } from './remove_backgroundRuntime';
