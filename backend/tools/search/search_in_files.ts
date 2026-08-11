/**
 * 在文件中搜索（和替换）内容工具
 *
 * 支持多工作区（Multi-root Workspaces）
 * 支持正则表达式搜索和替换
 *
 * 模块化拆分后的 re-export 壳：实现拆分至 search/declaration.ts（工具声明与
 * 动态描述）、search/searchPass.ts（搜索遍历与匹配）、search/replacePass.ts
 * （替换模式）、search/textEncoding.ts（编码探测）。
 * 本文件保持与拆分前完全相同的导出符号（createSearchInFilesTool / registerSearchInFiles），
 * 现有 import 不受影响。
 */
export { createSearchInFilesTool, registerSearchInFiles } from './declaration';
