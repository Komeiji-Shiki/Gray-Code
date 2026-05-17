/**
 * fast-tavern 核心数据结构
 * - 以 `st-api-wrapper` 的“新格式”字段为准
 * - 仅保留引擎真正需要的字段与行为（不做额外 API 封装）
 */

/** 统一的消息角色（引擎内部保留 system） */
export type Role = 'system' | 'user' | 'model';

// =========================
// 变量（对齐 st-api-wrapper）
// =========================

export type VariableScope = 'local' | 'global';

// =========================
// 正则（对齐 st-api-wrapper）
// =========================

export type RegexTarget = 'userInput' | 'aiOutput' | 'slashCommands' | 'worldBook' | 'reasoning';
export type RegexView = 'user' | 'model';
export type RegexMacroMode = 'none' | 'raw' | 'escaped';

export interface RegexScriptData {
  /** 唯一标识符 */
  id: string;
  /** 脚本名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 查找正则 */
  findRegex: string;
  /** 替换文本 */
  replaceRegex: string;
  /** 修剪文本列表（Trim Out） */
  trimRegex: string[];
  /** 作用位置列表（Affects） */
  targets: RegexTarget[];
  /** 视图过滤（user: 仅显示；model: 仅发送给模型） */
  view: RegexView[];
  /** 是否在编辑时运行（引擎内不使用，但保留字段） */
  runOnEdit: boolean;
  /**
   * 宏替换模式（仅影响 Find Regex）
   * - none: 不执行宏，按宏字面量查找（如 {{user}}）
   * - raw: 先执行宏，不转义
   * - escaped: 先执行宏，再做正则转义
   */
  macroMode: RegexMacroMode;
  /** 最小深度（聊天历史，0=最后一条）；null=无限制 */
  minDepth: number | null;
  /** 最大深度（聊天历史）；null=无限制 */
  maxDepth: number | null;
}

/**
 * 兼容外部一次性传入多个正则脚本文件的输入形态（多文件）。
 * 该类型不是 wrapper 的 API 类型，但便于 fast-tavern 作为引擎直接使用。
 */
export type RegexScriptsFileInput =
  | RegexScriptData[]
  | { regexScripts: RegexScriptData[] }
  | { scripts: RegexScriptData[] }
  | RegexScriptData;
export type RegexScriptsInput = RegexScriptsFileInput | RegexScriptsFileInput[];

// =========================
// 世界书（对齐 st-api-wrapper）
// =========================

export type WorldBookEntryPosition =
  | 'beforeChar'
  | 'afterChar'
  | 'beforeEm'
  | 'afterEm'
  | 'beforeAn'
  | 'afterAn'
  | 'fixed'
  | 'outlet'
  | string;

export type WorldBookEntryRole = 'system' | 'user' | 'model';
export type WorldBookEntrySelectiveLogic = 'andAny' | 'andAll' | 'notAll' | 'notAny';
export type WorldBookEntryActivationMode = 'always' | 'keyword' | 'vector';

export interface WorldBookEntry {
  index: number;
  name: string;
  content: string;
  enabled: boolean;
  activationMode: WorldBookEntryActivationMode;
  key: string[];
  secondaryKey: string[];
  selectiveLogic: WorldBookEntrySelectiveLogic;
  order: number;
  depth: number;
  position: WorldBookEntryPosition;
  /** 仅 fixed 有意义；不使用时为 null */
  role: WorldBookEntryRole | null;
  /** null: 使用默认；true/false: 显式覆盖 */
  caseSensitive: boolean | null;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  probability: number;
  other: Record<string, any>;
}

export interface WorldBook {
  name: string;
  entries: WorldBookEntry[];
}

/**
 * 兼容外部一次性传入多个世界书 JSON 文件的输入形态（多文件）。
 * 该类型不是 wrapper 的 API 类型，但便于 fast-tavern 作为引擎直接使用。
 */
export type WorldBookInput =
  | WorldBook
  | WorldBookEntry[]
  | { entries: WorldBookEntry[]; enabled?: boolean; name?: string };
export type WorldBooksInput = WorldBookInput | WorldBookInput[];

// =========================
// 预设（对齐 st-api-wrapper）
// =========================

/**
 * Utility Prompts：从 `other`（旧名 apiSetting）中迁移出来的一组常用字段。
 *
 * 对齐 st-api-wrapper/src/apis/preset/types.ts
 */
export interface UtilityPrompts {
  impersonationPrompt?: string;
  worldInfoFormat?: string;
  scenarioFormat?: string;
  personalityFormat?: string;
  groupNudgePrompt?: string;
  newChatPrompt?: string;
  newGroupChatPrompt?: string;
  newExampleChatPrompt?: string;
  continueNudgePrompt?: string;
  sendIfEmpty?: string;
  seed?: number;
}

export interface PromptInfo {
  identifier: string;
  name: string;
  /** 是否启用（若来自 ST，enabled 通常已融合 prompt_order 的状态） */
  enabled: boolean;
  /** 在预设顺序列表中的索引（可选） */
  index?: number;
  /** 角色：system/user/assistant/model/... */
  role: string;
  content: string;
  depth: number;
  order: number;
  trigger: any[];
  position: 'relative' | 'fixed';
  /** 其它原始字段（marker/forbid_overrides/...） */
  [key: string]: any;
}

export interface PresetInfo {
  name: string;
  prompts: PromptInfo[];

  /** 从 other 中迁移出的 Utility Prompts（camelCase） */
  utilityPrompts: UtilityPrompts;

  /** 预设绑定正则脚本 */
  regexScripts: RegexScriptData[];

  /**
   * 其它采样参数（旧名 apiSetting）
   */
  other: any;

  /** @deprecated 已重命名为 other */
  apiSetting?: any;
}

// =========================
// 角色卡（对齐 st-api-wrapper）
// =========================

export interface CharacterCard {
  name: string;
  description: string;
  avatar: string;
  message: string[];
  worldBook: WorldBook | null;
  regexScripts: RegexScriptData[];
  other: Record<string, any>;
  chatDate: string;
  createDate: string;
}

// =========================
// 聊天历史（对齐 st-api-wrapper）
// =========================

/** 通用消息 Part 定义（参考 Gemini） */
export type MessagePart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

/**
 * 消息结构（支持 Gemini/OpenAI 风格，并包含多分支信息）
 */
export type ChatMessage = {
  role: string;
  name?: string;
  swipeId?: number;
} & (
  | { parts: MessagePart[]; swipes?: MessagePart[][] }
  | { content: string; swipes?: string[] }
);

// =========================
// 引擎内部调试结构
// =========================

export interface TaggedContent {
  tag: string;
  role: Role;
  text: string;
  target: RegexTarget;
  /** 若该条目来自聊天历史，则为“从末尾计数”的 depth（0=最后一条） */
  historyDepth?: number;
}

export type OutputFormat = 'gemini' | 'openai' | 'tagged' | 'text';

export interface PromptStages<T> {
  /** 原始视图：仅完成组装，尚未进入宏/正则管道 */
  raw: T;
  /** 宏前视图：为兼容旧调试结构保留；在新语义下等同 raw */
  afterPreRegex: T;
  /** 宏执行完视图 */
  afterMacro: T;
  /** 正则执行完视图（最终视图） */
  afterPostRegex: T;
}

export interface PerItemStages {
  tag: string;
  role: Role;
  target: RegexTarget;
  historyDepth?: number;

  raw: string;
  afterPreRegex: string;
  afterMacro: string;
  afterPostRegex: string;
}

export interface BuildPromptParams {
  preset: PresetInfo;
  character?: CharacterCard;
  globals?: {
    worldBooks?: WorldBooksInput;
    regexScripts?: RegexScriptsInput;
  };

  history: ChatMessage[];
  view: RegexView;

  /** 输出格式；默认 gemini（parts） */
  outputFormat?: OutputFormat;

  /**
   * system 角色输出策略（仅影响最终 output / stages.output）。
   * - keep: 保留 system
   * - to_user: 将 system 降级为 user（用于下游不接受 system 的渠道）
   */
  systemRolePolicy?: 'keep' | 'to_user';

  /** 宏变量（char 会从 character 自动提取，若你未显式提供） */
  macros?: Record<string, string>;

  /** 局部变量初始值（可选）。用于 {{getvar}}/{{setvar}} 等宏。 */
  variables?: Record<string, any>;

  /** 全局变量初始值（可选）。用于 {{getglobalvar}}/{{setglobalvar}} 等宏。 */
  globalVariables?: Record<string, any>;

  options?: {
    /** 世界书匹配上下文使用最近几条聊天历史；默认 5 */
    recentHistoryForWorldbook?: number;

    /**
     * 世界书 position 到 preset prompt.identifier 的映射（用于插槽条目）。
     * - position='fixed' 不参与映射（它会注入到 chatHistory）
     */
    positionMap?: Partial<Record<string, string>>;

    /**
     * vector 激活回调（activationMode='vector'）。
     * 默认：不触发 vector 条目。
     */
    vectorSearch?: (params: {
      entries: WorldBookEntry[];
      contextText: string;
    }) => Set<number> | number[] | Promise<Set<number> | number[]>;

    /** 递归激活最大迭代次数；默认 5 */
    recursionLimit?: number;

    /** 随机数发生器（用于 probability）；默认 Math.random */
    rng?: () => number;

    /** caseSensitive=null 时的默认行为；默认 false（不区分大小写） */
    defaultCaseSensitive?: boolean;
  };
}

export interface BuildPromptResult {
  outputFormat: OutputFormat;
  systemRolePolicy: 'keep' | 'to_user';

  /** 世界书激活结果 */
  activeWorldbookEntries: WorldBookEntry[];

  /** 合并后的正则脚本（global + preset + character） */
  mergedRegexScripts: RegexScriptData[];

  /** 变量最终状态（用于持久化） */
  variables: {
    local: Record<string, any>;
    global: Record<string, any>;
  };

  stages: {
    tagged: PromptStages<TaggedContent[]>;
    /** 内部统一后的 gemini(parts) 输出（role: system/user/model） */
    internal: PromptStages<ChatMessage[]>;
    /** 按 outputFormat 转换后的最终输出 */
    output: PromptStages<ChatMessage[] | TaggedContent[] | string>;
    perItem: PerItemStages[];
  };
}


// =========================
// 旧酒馆格式包装入口参数
// =========================

/**
 * 旧酒馆（SillyTavern 原始结构）包装构建参数：
 * 先转换为新格式，再执行 buildPrompt。
 */
export interface BuildPromptFromSillyTavernParams {
  /** ST 原始 preset（settings）对象 */
  preset: any;

  /** ST 原始角色卡对象（可选） */
  character?: any;

  /** ST 原始全局资源（可选） */
  globals?: {
    worldBooks?: any;
    regexScripts?: any;
  };

  /** ST 原始聊天历史数组（chat[]） */
  history: any[];

  view: RegexView;
  outputFormat?: OutputFormat;
  systemRolePolicy?: 'keep' | 'to_user';

  macros?: Record<string, string>;
  variables?: Record<string, any>;
  globalVariables?: Record<string, any>;

  options?: BuildPromptParams['options'];
}

