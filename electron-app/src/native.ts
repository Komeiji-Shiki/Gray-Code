/**
 * native.ts - Native operations for the vscode shim (run in the main process).
 */

import { dialog, shell, clipboard, BrowserWindow } from 'electron';
import * as fs from 'fs';

let pickWorkspaceHandler: (() => void) | null = null;

/** Set by main.ts: opens the "Open Workspace Folder" dialog. */
export function setPickWorkspaceHandler(handler: (() => void) | null): void {
  pickWorkspaceHandler = handler;
}

export async function runNative<T = any>(
  op: string,
  payload: any,
  win: BrowserWindow | null
): Promise<T> {
  switch (op) {
    case 'workspace:pickFolder':
      pickWorkspaceHandler?.();
      return { ok: true } as T;
    case 'dialog:open': {
      const options = payload || {};
      const result = await dialog.showOpenDialog(win!, {
        title: options.title,
        buttonLabel: options.openLabel,
        filters: options.filters,
        properties: [
          ...(options.canSelectFiles !== false ? (['openFile'] as const) : []),
          ...(options.canSelectFolders ? (['openDirectory'] as const) : []),
          ...(options.canSelectMany ? (['multiSelections'] as const) : [])
        ]
      });
      return { filePaths: result.filePaths, canceled: result.canceled } as T;
    }
    case 'dialog:save': {
      const options = payload || {};
      const result = await dialog.showSaveDialog(win!, {
        title: options.title,
        defaultPath: options.defaultUri?.fsPath,
        filters: options.filters
      });
      return { filePath: result.filePath, canceled: result.canceled } as T;
    }
    case 'shell:openPath': {
      const error = await shell.openPath(payload?.path);
      return { ok: !error } as T;
    }
    case 'shell:showInFolder':
      shell.showItemInFolder(payload?.path);
      return { ok: true } as T;
    case 'shell:openExternal':
      await shell.openExternal(payload?.url);
      return { ok: true } as T;
    case 'clipboard:write':
      clipboard.writeText(String(payload?.text ?? ''));
      return { ok: true } as T;
    case 'clipboard:read':
      return clipboard.readText() as T;
    case 'window:reload':
      win?.webContents.reload();
      return { ok: true } as T;
    case 'fs:exists':
      return { exists: fs.existsSync(payload?.path) } as T;
    default:
      throw new Error(`Unknown native op: ${op}`);
  }
}
