import type { FileEntryInfo } from '@graycode/contracts';
export interface FileDialogRequest {
  kind: 'file' | 'directory' | 'move' | 'remove' | 'upload';
  workspaceId: string;
  path: string;
  entry?: FileEntryInfo;
  files?: File[];
}
