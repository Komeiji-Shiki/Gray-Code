import { shellText as t } from './i18n';
import type { MemoryImportFile } from '@graycode/contracts';
import { call } from './api';

/** 按固定块读取并验证完整文件，取消或切换文件后停止后续请求。 */
export async function loadMemoryImportFile(datasetId: string, file: MemoryImportFile, signal: AbortSignal, progress: (bytes: number) => void): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  for (let index = 0; index < file.chunks; index++) {
    signal.throwIfAborted();
    const result = await call<{ data: string; index: number }>('memory.import.chunk', { id: datasetId, fileId: file.id, index });
    signal.throwIfAborted();
    if (result.index !== index) throw new Error(t('uimemoryImportsFileChunkOrderMismatch'));
    const data = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
    chunks.push(data);
    bytes += data.byteLength;
    progress(bytes);
  }
  const blob = new Blob(chunks, { type: file.mimeType });
  if (bytes !== file.bytes) throw new Error(t('uimemoryImportsOriginalFileLengthMismatch'));
  if (!crypto.subtle) throw new Error(t('uimemoryImportsSecureContextRequired'));
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  signal.throwIfAborted();
  if (Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('') !== file.sha256)
    throw new Error(t('uimemoryImportsOriginalFileVerificationFailed'));
  return blob;
}

export function memoryFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
