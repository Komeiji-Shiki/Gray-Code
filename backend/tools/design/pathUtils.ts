/**
 * Design 工具路径辅助函数
 *
 * 修改原因：与 plan/progress 的 pathUtils 同构（多根工作区前缀校验 + 父目录创建），
 * 收敛到 ../pathPolicy 统一实现，本文件保留原导出名与签名。
 */

import { isScopedPathAllowedWithMultiRoot, ensureParentDir } from '../pathPolicy';
import { isDesignPathAllowed } from '../../modules/settings/modeToolsPolicy';

export function isDesignModePathAllowedWithMultiRoot(pathStr: string): boolean {
  return isScopedPathAllowedWithMultiRoot(pathStr, isDesignPathAllowed);
}

export { ensureParentDir };
