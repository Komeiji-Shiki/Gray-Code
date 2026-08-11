/**
 * Plan 工具路径辅助函数
 */

import { isPlanPathAllowed } from '../../modules/settings/modeToolsPolicy';
import { ensureParentDir, isScopedPathAllowedWithMultiRoot } from '../shared/pathPolicy';

export function isPlanModePathAllowedWithMultiRoot(pathStr: string): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isPlanPathAllowed);
}

export { ensureParentDir };
