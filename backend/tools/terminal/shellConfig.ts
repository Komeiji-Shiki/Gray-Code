import { createShellRuntime } from './shellConfigRuntime';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultExecuteCommandConfig } from '../../modules/settings/types/toolsTypes';
const getConfig = () => getGlobalSettingsManager()?.getExecuteCommandConfig() ?? getDefaultExecuteCommandConfig();
const runtime = createShellRuntime({ getConfig });
export const { getShellConfig, getEnabledShellTypes, checkShellAvailability, checkAllShellsAvailability, getAvailableShellsDescription, getDefaultShellName, getEnabledShellTypesForEnum, getDefaultShellType, getUnavailableShellsDescription } = runtime;
export type { ShellType } from './shellConfigRuntime';
