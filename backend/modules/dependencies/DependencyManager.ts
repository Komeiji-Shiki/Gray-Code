/** VS Code 只负责持有扩展实例，依赖安装与加载复用独立 Node 实现。 */
import type { ExtensionContext } from 'vscode';
import { t } from '../../i18n';
import { DependencyRuntimeManager } from './DependencyRuntimeManager';
import { setDependencyRuntime } from './runtime';
export { getDependencyPath, getSharp, getPdfjs, getCanvas } from './runtime';
export { NPM_OUTPUT_MAX_BYTES, type DependencyInfo, type InstallProgressEvent } from './DependencyRuntimeManager';

export class DependencyManager extends DependencyRuntimeManager {
    private static instance: DependencyManager;
    static getInstance(context?: ExtensionContext, customDepsPath?: string): DependencyManager {
        const current = DependencyManager.instance;
        if (!current || (customDepsPath !== undefined && customDepsPath !== current.getInstallPath())) {
            if (!context) throw new Error(t('modules.dependencies.errors.requiresContext'));
            DependencyManager.instance = new DependencyManager(customDepsPath);
        }
        return DependencyManager.instance;
    }
}
setDependencyRuntime(() => DependencyManager.getInstance());
