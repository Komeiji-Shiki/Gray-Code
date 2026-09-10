import * as path from 'path';
/** 原输入文件类型识别，供扩展与独立平台共用。 */
export const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.csv', '.sql',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.kts', '.sh', '.bash', '.zsh', '.ps1',
  '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig'
]);
export const BINARY_FILE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg',
  '.mp4', '.webm', '.avi', '.mov', '.mkv',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.wasm'
]);
export function inferMimeTypeByPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript'
  };

  return map[ext] || 'application/octet-stream';
}
export function isLikelyTextFile(relativePath: string, content: Uint8Array): boolean {
  if (!content || content.length === 0) return true;

  const ext = path.extname(relativePath).toLowerCase();
  if (TEXT_FILE_EXTENSIONS.has(ext)) return true;
  if (BINARY_FILE_EXTENSIONS.has(ext)) return false;

  const sampleLength = Math.min(content.length, 8192);
  let suspiciousControlCount = 0;

  for (let i = 0; i < sampleLength; i++) {
    const byte = content[i];
    if (byte === 0) return false;
    if ((byte < 7 || (byte > 14 && byte < 32)) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspiciousControlCount++;
    }
  }

  return (suspiciousControlCount / sampleLength) < 0.2;
}