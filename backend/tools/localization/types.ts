/**
 * GrayCode - 模型工具声明本地化类型
 *
 * 只服务模型可见的工具声明（description / 参数说明），
 * 不并入 UI/运行时错误语言包，避免大段工具提示词膨胀 BackendLanguageMessages，
 * 也避免要求日文语言包机械复制英文内容。
 */

/** 本地化目录支持的语言（ja 映射到 en，见 resolveLocalizationLanguage） */
export type LocalizationLanguage = 'zh-CN' | 'en';

/** 单个工具的中英文说明覆盖项 */
export interface ToolDescriptionLocalization {
    /**
     * 顶层说明覆盖。
     * 动态工具（read_file、图片工具、execute_command、history_search、read_skill、
     * subagents、agent_send_message）不配置此项——其顶层说明由语言感知生成器负责，
     * 目录只覆盖参数说明，避免静态文本覆盖掉运行时动态信息。
     */
    description?: string;
    /**
     * 参数说明覆盖：key 为稳定路径。
     * 支持格式：path、files、files[].path、hunks[].oldContent、
     * structuredFindings[].evidence[].path。
     * 找不到路径时保留原说明，不删除信息。
     */
    parameters?: Record<string, string>;
}

/**
 * 把进程级实际语言（zh-CN/en/ja）映射到本地化目录语言。
 * - zh-CN → zh-CN：模型看到简体中文说明；
 * - en → en：模型看到英文说明；
 * - ja → en：本阶段日文暂用英文模型说明，避免引入质量不足的日文长提示词。
 */
export function resolveLocalizationLanguage(actual: string): LocalizationLanguage {
    return actual === 'zh-CN' ? 'zh-CN' : 'en';
}
