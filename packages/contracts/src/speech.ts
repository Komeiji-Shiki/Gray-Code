/** 文字转语音的提供商；system 使用 Windows 本机语音，其余通过 HTTP 接口合成。 */
export type SpeechProvider = 'fish' | 'openai' | 'qwen' | 'system';

export interface SpeechSettings {
  enabled: boolean;
  provider: SpeechProvider;
  /** OpenAI 兼容接口的根地址、Fish Audio 的 API 地址，或 Qwen 的合成接口完整地址。 */
  endpoint?: string;
  credentialRef?: string;
  model?: string;
  /** OpenAI 兼容接口的音色（如 alloy）或 Windows 本机语音名称。 */
  voice?: string;
  /** Fish Audio 克隆音色的 reference_id。 */
  referenceId?: string;
  speed?: number;
  format?: 'mp3' | 'wav' | 'opus';
  /** 助手回复完成后自动朗读最新一条回复。 */
  autoPlay?: boolean;
}

export interface SpeechStatus {
  available: boolean;
  enabled: boolean;
  provider: SpeechProvider;
  /** 仅 system 提供商返回本机已安装的语音名称。 */
  systemVoices?: string[];
  error?: string;
}

export interface SpeechClip {
  text: string;
  mimeType: string;
  base64: string;
}

export interface SpeechSynthesisResult {
  provider: SpeechProvider;
  voice?: string;
  clips: SpeechClip[];
}

export interface SpeechCloneInput {
  title: string;
  /** 参考录音内容，base64 编码。 */
  audio: string;
  mimeType: string;
  /** 参考录音实际说出的文字；Fish 的快速训练模式可省略。 */
  text?: string;
}

export interface SpeechCloneResult {
  id: string;
  state?: string;
  title?: string;
}
