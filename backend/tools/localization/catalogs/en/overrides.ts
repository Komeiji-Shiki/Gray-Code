/**
 * GrayCode - 英文工具说明覆盖
 *
 * 英文语言下默认使用工具原始英文声明；本文件只覆盖：
 * - 原文错误（如 delete_code 参数说明中 parameterMUST 的拼写）；
 * - 需要统一风格或补充高价值语义的工具。
 *
 * 注意：动态工具（read_file、图片工具、execute_command、history_search、read_skill、
 * subagents、agent_send_message）不配置 description，顶层说明由语言感知生成器负责。
 */

import type { ToolDescriptionLocalization } from '../../types';

export const overrides: Record<string, ToolDescriptionLocalization> = {
    // delete_code 的 "parameterMUST" 拼写错误位于其顶层 description
    // （"The `files` parameterMUST be an array..."）。该顶层说明会随多根工作区动态拼接
    // 工作区名单，不能整体覆盖；因此在这里提供修正后的 files 参数说明，
    // 让模型在参数层看到正确的 "MUST be an array" 语义与示例。
    delete_code: {
        parameters: {
            files: 'Array of delete operations. Each element specifies a file and line range to delete. MUST be an array even for a single file. Example: `{"files": [{"path": "file.ts", "start_line": 10, "end_line": 20}]}`.'
        }
    }
};
