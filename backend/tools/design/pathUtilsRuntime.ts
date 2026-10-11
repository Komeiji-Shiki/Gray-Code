/**
 * Design 工具路径辅助函数
 */

import { isDesignPathAllowed } from '../../modules/settings/modeToolsPolicy';
import { ensureParentDirWithFs, isScopedPathAllowedWithMultiRoot } from '../shared/artifactHost';

export function isDesignModePathAllowedWithMultiRoot(pathStr: string): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isDesignPathAllowed);
}

// 目录创建由当前工作区宿主负责，文档工具只传入目标文件路径。
export { ensureParentDirWithFs as ensureParentDir };
