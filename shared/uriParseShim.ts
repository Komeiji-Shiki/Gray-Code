/**
 * `file://` URI → 文件系统路径 的归一化逻辑（Uri.parse shim 共用，E-21）。
 *
 * 原先分别在 test/benchmark/benchmarkHarness.ts 与 backend/__tests__/__mocks__/vscode.ts
 * 各写一份、靠注释约定「保持一致」，一处修复（如 Windows 盘符、file:/// 三斜杠处理）
 * 容易忘记同步另一处；现收敛到 shared/，两处 shim 都从这里 import。
 *
 * 规则（与原两处实现一致）：
 * - 只去掉 scheme 的 `file://`（两个斜杠），`file:///abs/path` 中属于路径本身的前导
 *   斜杠必须保留——否则 Linux 上绝对路径会被解析成相对路径；
 * - Windows 的 `file://C:/` 形式只有两个斜杠恰好不触发，且盘符路径在非 Windows 上
 *   需补回前导斜杠（`C:/x` → `/C:/x`）。
 *
 * @param value 原始 URI 字符串（可能含百分号编码，先 decodeURIComponent）
 * @returns 文件系统路径；非 file:// 输入返回 null（调用方自行按其他 scheme 处理）
 */
export function fileUriToFilePath(value: string): string | null {
    const decoded = decodeURIComponent(value);
    if (!/^file:\/\//i.test(decoded)) {
        return null;
    }
    let filePath = decoded.replace(/^file:\/\//i, '');
    if (process.platform !== 'win32' && /^[a-zA-Z]:\//.test(filePath)) {
        filePath = `/${filePath}`;
    }
    return filePath;
}
