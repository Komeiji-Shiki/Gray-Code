import type { SettingsManager } from '../settings/SettingsManager'
export function wrapPromptSection(title: string, content: string | null): string { return content ? `====\n\n${title}\n\n${content}` : '' }
export function generateContextBadgeFormatSection(settingsManager?: SettingsManager | null): string {
        // 修改原因：旧示例使用了 "新建文件夹 (10).zip" 这种看起来像真实用户文件的名称，
        //          导致模型在 system prompt 中看到后误以为用户实际附加了该文件。
        // 修改方式：改用明显虚构的 "example-report.pdf"，并标注 "(example)"。
        return [
            'Context chips are serialized inline with this XML-like structure (example):',
            '<lim-context type="file" path="example-report.pdf" binary="true" title="example-report.pdf (example)">',
            '',
            '</lim-context>',
            '',
            'Field meanings:',
            '- type: context kind (file | text | snippet).',
            '- path: source file path (usually workspace-relative) when type="file".',
            '- title: chip display title shown to users. This is the title, NOT the body content.',
            '- binary="true": indicates non-text/binary attachment context. In this case, the tag body is intentionally empty and must NOT be parsed as text content.',
            '',
            'Important parsing rules:',
            '- The BODY content is only the text between opening/closing tags.',
            '- The TITLE is only the title attribute value.',
            '- If binary="true", treat this block as a structural reference/attachment marker only; do not try to summarize or infer textual body from title/path/file name.'
        ].join('\n')
    }

export function generateMemorySection(settingsManager?: SettingsManager | null): string {
        const memoryConfig = settingsManager?.getMemoryConfig?.();
        if (memoryConfig?.enabled === false) {
            return '';
        }
        const userPrompt = typeof memoryConfig?.systemPrompt === 'string' ? memoryConfig.systemPrompt.trim() : '';

        if (userPrompt) {
            return wrapPromptSection('MEMORY', userPrompt);
        }

        // 默认内置提示词
        const defaultPrompt = [
            '长期记忆使用规则',
            '',
            '在新的工作会话开始、且历史约定可能影响当前任务时，先运行 memory_wake。简单、无需工具且与历史无关的回复不必为了形式调用它。若输出分页，按顺序读到 “You are awake.”。',
            '',
            '记忆分为全局记忆和当前工作区记忆；注意 memory_wake 的作用域标记。memory_note 默认写入当前工作区。',
            '',
            '只记录未来会话仍可能有用的持久信息，例如用户明确的偏好与约定、长期生效的项目决策、难以从仓库重建的事实，以及反复出现且已验证的解决办法。',
            '',
            '不要记录工作日志、当前进度、下一步、已运行的验证、可从代码或 Git 历史直接重建的内容、重复信息、凭据或秘密。除非用户明确要求，不要主动保存敏感个人信息。拿不准时不要记录。',
            '',
            '压缩不得打断当前用户任务。成功的 memory_note 或 memory_wake 返回 pendingCompression 时，它只是可延后的维护提示：先完成当前交付，再在合适时调用 memory_compress。只有 memory_wake 明确因缺少必要摘要而失败时，才先完成它要求的压缩并重试 wake。',
            '',
            '压缩时只概括提示中给出的内容，保留持久的决定、偏好、约束、事实及必要上下文，删除临时进度与重复，不得编造。不同作用域的独立压缩可以放在同一响应中调用。',
            '',
        ].join('\n');

        return wrapPromptSection('MEMORY', defaultPrompt);
    }
