/**
 * 存储 ID 安全校验（拆分自 storage.ts）。
 *
 * conversationId / snapshotId 会来自 Webview 消息和导入数据，不能在未校验时交给
 * Uri.joinPath。只允许项目当前生成器使用的 ASCII 安全集合，既覆盖 conv_*、UUID、
 * 测试中的 c-*，也从根源拒绝 ..、路径分隔符、盘符与 URI 编码绕过。
 *
 * storage.ts 通过 `export { assertSafeStorageId } from './storageIds'` 再导出；
 * FileSystemStorageAdapter 直接引用本文件，避免与 storage.ts 形成运行时循环依赖。
 */
export function assertSafeStorageId(value: unknown, label = 'storage id'): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error(`Unsafe ${label}: ${String(value)}`);
    }
}
