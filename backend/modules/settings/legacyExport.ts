/** 保留原扩展支持的 LimCode 导出格式，调用者传入独立的解析结果。 */
export function migrateLimCodeExport(value: Record<string, unknown>): void {
  if (typeof value.limcodeVersion !== 'string' || !value.limcodeVersion) return;
  if (value.vscodeSettings && typeof value.vscodeSettings === 'object') {
    value.vscodeSettings = Object.fromEntries(Object.entries(value.vscodeSettings).map(([key, item]) => [
      key.startsWith('limcode.') ? key.replace('limcode.', 'graycode.') : key, item,
    ]));
  }
  if (Array.isArray(value.skills)) for (const skill of value.skills) {
    if (!skill || typeof skill !== 'object') continue;
    if (skill.source === 'user-limcode') skill.source = 'user-graycode';
    else if (skill.source === 'project-limcode') skill.source = 'project-graycode';
  }
  value.graycodeVersion = value.limcodeVersion;
  delete value.limcodeVersion;
}
