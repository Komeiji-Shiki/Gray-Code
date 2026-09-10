export const UI_FILE_UPLOAD_LIMIT = 64 * 1024 * 1024;
/** 目录项版本用于重命名、删除和上传确认；正文编辑继续使用内容哈希。 */
export interface FileEntryInfo {
  path: string;
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'missing';
  size: number;
  modifiedAt: number;
  version: string;
}
