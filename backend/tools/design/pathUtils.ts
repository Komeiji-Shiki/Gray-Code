/**
 * Design 工具路径辅助函数
 */

import { isDesignPathAllowed } from '../../modules/settings/modeToolsPolicy';
import { ensureParentDirWithFs, isScopedPathAllowedWithMultiRoot } from '../shared/pathPolicy';

export function isDesignModePathAllowedWithMultiRoot(pathStr: string): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isDesignPathAllowed);
}

// design 保留本地 fs.promises.mkdir 实现：远程/虚拟工作区下与 vscode.workspace.fs 行为
// 有差异，且 create/update 测试基于 fs.promises.mkdir mock；详见 shared/pathPolicy.ts 说明。
export { ensureParentDirWithFs as ensureParentDir };
