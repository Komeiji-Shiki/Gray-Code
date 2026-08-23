export interface WebviewAssetInfo {
  /** Rollup 旧版/兼容字段。 */
  name?: string
  /** Rollup 4 为同一资源保留的全部候选名称。 */
  names?: readonly string[]
}

/**
 * 保持 Webview 的主样式入口稳定，同时让异步 chunk 的样式拥有独立文件名。
 *
 * VS Code Webview 不直接使用 Vite 生成的 index.html，而是加载固定的 index.css。
 * 因此主入口样式必须始终保留该名称；其他 CSS 若也强制命名为 index.css，
 * Rollup 会自动追加 index2/index3 等后缀，主样式最终落到哪个编号将不再稳定。
 */
export function resolveWebviewAssetFileName(assetInfo: WebviewAssetInfo): string {
  const names = assetInfo.names?.length
    ? assetInfo.names
    : assetInfo.name
      ? [assetInfo.name]
      : []

  if (names.includes('index.css')) {
    return 'index.css'
  }

  if (names.some(name => name.endsWith('.css'))) {
    return 'assets/[name]-[hash][extname]'
  }

  return 'assets/[name][extname]'
}
