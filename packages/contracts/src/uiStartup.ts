import type { AppearanceSettings } from './settings';
import type { ChannelConfig } from './channels';

/** 旧设置模块保留其业务类型，启动契约只组合结果，避免协议层反向依赖 backend。 */
export interface UiStartupSnapshot<Settings extends object = object, PromptMode extends object = object,
  CheckpointConfig extends object = object> {
  state: unknown;
  appearance: AppearanceSettings;
  settings: { success: true; settings: Settings };
  promptModes: {
    modes: PromptMode[];
    currentModeId: string;
    dynamicContextStrategy: 'single' | 'preserve';
  };
  activeChannel: { channelId?: string };
  checkpoint: { config: CheckpointConfig };
  workspaceUri: string | null;
  channels?: ChannelConfig[];
}
