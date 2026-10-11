import { PromptAssembler, type PromptAssemblyHost } from '../../modules/prompt/PromptAssembler';
import { wrapPromptSection } from '../../modules/prompt/commonSections';
import type { PromptConfig } from '../../modules/prompt/types';
import type { SettingsManager } from '../../modules/settings/SettingsManager';

/** 模板算法用例只注入宿主资料，不依赖扩展的全局设置或编辑器。 */
export function createPromptAssembler(settings: SettingsManager, config: Partial<PromptConfig> = {}): PromptAssembler {
    const sections: PromptAssemblyHost['sections'] = {
        wrapSection: wrapPromptSection,
        cleanupEmptyLines: text => text.replace(/\n{3,}/g, '\n\n').trim(),
        getUserLanguage: () => 'zh-CN',
        generateStaticEnvironmentSection: () => 'Test workspace',
        generateContextBadgeFormatSection: () => '',
        generateMemorySection: () => '',
        generateFileTreeSection: () => '',
        generateOpenTabsSection: () => '',
        generateActiveEditorSection: () => '',
        generateDiagnosticsSection: () => '',
        generatePinnedFilesSection: () => '',
        getContext: () => ({})
    };
    return new PromptAssembler({ settings: () => settings, workspacePaths: () => [], sections }, config);
}
