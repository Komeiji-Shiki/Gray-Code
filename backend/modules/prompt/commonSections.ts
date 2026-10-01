import type { SettingsManager } from '../settings/SettingsManager'
import { DEFAULT_MEMORY_PROMPT } from '../../../shared/defaultPromptTemplates'
export function wrapPromptSection(title: string, content: string | null): string { return content ? `====\n\n${title}\n\n${content}` : '' }
export function generateContextBadgeFormatSection(settingsManager?: SettingsManager | null): string {
        // 示例用明显虚构的文件名并标注 (example)：更像真实文件的名称曾让模型误以为用户附加了它。
        return [
            'Files, text and snippets the user attaches appear inline as context blocks like this (example only):',
            '<lim-context type="file" path="example-report.pdf" binary="true" title="example-report.pdf (example)">',
            '',
            '</lim-context>',
            '',
            '- type is file, text or snippet. For files, path is the source path, usually relative to the workspace.',
            '- title is the label shown to the user, not part of the content. The content is only the text between the opening and closing tags.',
            '- binary="true" marks a non-text attachment, such as an image or PDF delivered separately. Its tag body is empty on purpose; do not infer or summarize content from its title, path or file name.'
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

        return wrapPromptSection('MEMORY', DEFAULT_MEMORY_PROMPT);
    }
