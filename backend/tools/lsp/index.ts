/**
 * LSP 工具模块
 *
 * 提供基于 Language Server Protocol 的代码导航和智能分析工具
 */

// 导出各个工具的创建函数
export { registerGetSymbols } from './get_symbols';
export { registerGotoDefinition } from './goto_definition';
export { registerFindReferences } from './find_references';

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { registerGetSymbols } from './get_symbols';
import { registerGotoDefinition } from './goto_definition';
import { registerFindReferences } from './find_references';

/**
 * 获取所有 LSP 工具的注册函数
 * @returns 注册函数数组
 */
export function getLspToolRegistrations() {
    return [
        registerGetSymbols,
        registerGotoDefinition,
        registerFindReferences,
    ];
}
