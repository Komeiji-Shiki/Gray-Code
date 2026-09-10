import { createOutputRuntime } from './outputDecoderRuntime';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultExecuteCommandConfig } from '../../modules/settings/types/toolsTypes';
const getConfig = () => getGlobalSettingsManager()?.getExecuteCommandConfig() ?? getDefaultExecuteCommandConfig();
const runtime = createOutputRuntime({ getConfig });
export const { pushOutputLines, getMaxOutputLines, getLastLines, decodeWithMode, flushDecodeState } = runtime;
export type { StreamDecodeMode, StreamDecodeState } from './outputDecoderRuntime';
