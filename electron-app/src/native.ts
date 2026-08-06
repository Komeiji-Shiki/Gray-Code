/**
 * native.ts - Native operations for the vscode shim (run in the main process).
 *
 * 安全加固：所有可被渲染层触发的操作都做输入校验。
 * - openExternal 仅允许 https/http/mailto
 * - openPath / showInFolder 拒绝可执行扩展名
 */

import { dialog, shell, clipboard, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

let pickWorkspaceHandler: (() => void) | null = null;
let openWorkspaceHandler: ((fsPath: string) => void) | null = null;

/** Set by main.ts: opens the "Open Workspace Folder" dialog. */
export function setPickWorkspaceHandler(handler: (() => void) | null): void {
  pickWorkspaceHandler = handler;
}

/** Set by main.ts: opens the given folder as the current workspace (saved workspace open). */
export function setOpenWorkspaceHandler(handler: ((fsPath: string) => void) | null): void {
  openWorkspaceHandler = handler;
}

/** 可执行/脚本类扩展名：openPath/showInFolder 一律拒绝，防止渲染层被攻破后直接启动本机程序 */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif',
  '.sh', '.bash', '.csh', '.ksh', '.zsh', '.py', '.rb', '.pl', '.jar',
  // 黑名单补充（H-2）：以下扩展名可被系统直接解释执行或携带代码，
  // 缺失时会构成"AI 写入文件 → 用户打开 → 任意代码执行"的现实链路
  '.hta', '.lnk', '.url', '.reg', '.iso', '.vhd', '.vhdx',
  '.docm', '.xlsm', '.pptm', '.svg'
]);

function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isAllowedOpenPath(filePath: string): boolean {
  try {
    // 目录允许打开（资源管理器中查看文件夹）
    let isDir = false;
    try {
      isDir = fs.statSync(filePath).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) return true;
    const ext = path.extname(filePath).toLowerCase();
    if (!ext) return false; // 无扩展名文件不允许直接打开（无法判断其类型）
    return !EXECUTABLE_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function normalizeDialogFilters(filters: any): Electron.FileFilter[] | undefined {
  // VS Code 契约：filters 是 { 'JSON Files': ['json'], ... } 对象；
  // Electron 契约：数组 [{ name, extensions }]。原样透传会让 Electron
  // 校验失败（对话框不弹出）或过滤被静默忽略。
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) {
    return filters as Electron.FileFilter[] | undefined;
  }
  const out: Electron.FileFilter[] = [];
  for (const [name, exts] of Object.entries(filters)) {
    if (Array.isArray(exts) && exts.length > 0) {
      out.push({ name, extensions: exts.map((e) => String(e)) });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** 窗口可能已销毁（关闭竞态）：isDestroyed 的窗口传给 dialog/webContents 会抛 "Object has been destroyed" */
function usableWindow(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export async function runNative<T = any>(
  op: string,
  payload: any,
  win: BrowserWindow | null
): Promise<T> {
  const w = usableWindow(win);
  switch (op) {
    case 'workspace:pickFolder':
      pickWorkspaceHandler?.();
      return { ok: true } as T;
    case 'workspace:openFolder': {
      const target = typeof payload?.fsPath === 'string' ? payload.fsPath : '';
      if (target) openWorkspaceHandler?.(target);
      return { ok: true } as T;
    }
    case 'dialog:open': {
      const options = payload || {};
      // 窗口可能已销毁（竞态）：无窗口时退化为无父窗口对话框，避免 win! 传 null 抛 TypeError
      const dialogOptions: Electron.OpenDialogOptions = {
        title: options.title,
        buttonLabel: options.openLabel,
        filters: normalizeDialogFilters(options.filters),
        properties: [
          ...(options.canSelectFiles !== false ? (['openFile'] as const) : []),
          ...(options.canSelectFolders ? (['openDirectory'] as const) : []),
          ...(options.canSelectMany ? (['multiSelections'] as const) : [])
        ]
      };
      const result = w
        ? await dialog.showOpenDialog(w, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return { filePaths: result.filePaths, canceled: result.canceled } as T;
    }
    case 'dialog:save': {
      const options = payload || {};
      const dialogOptions: Electron.SaveDialogOptions = {
        title: options.title,
        defaultPath: options.defaultUri?.fsPath,
        filters: normalizeDialogFilters(options.filters)
      };
      const result = w
        ? await dialog.showSaveDialog(w, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      return { filePath: result.filePath, canceled: result.canceled } as T;
    }
    case 'shell:openPath': {
      const target = typeof payload?.path === 'string' ? payload.path : '';
      if (!isAllowedOpenPath(target)) {
        return { ok: false, error: `Refusing to open file: ${target || '(empty)'}` } as T;
      }
      const error = await shell.openPath(target);
      return { ok: !error } as T;
    }
    case 'shell:showInFolder': {
      const target = typeof payload?.path === 'string' ? payload.path : '';
      if (!isAllowedOpenPath(target)) {
        return { ok: false, error: `Refusing to reveal file: ${target || '(empty)'}` } as T;
      }
      shell.showItemInFolder(target);
      return { ok: true } as T;
    }
    case 'shell:openExternal': {
      const target = typeof payload?.url === 'string' ? payload.url : '';
      if (!isAllowedExternalUrl(target)) {
        return { ok: false, error: `Refusing to open URL (only http/https/mailto allowed): ${target || '(empty)'}` } as T;
      }
      await shell.openExternal(target);
      return { ok: true } as T;
    }
    case 'clipboard:write':
      clipboard.writeText(String(payload?.text ?? ''));
      return { ok: true } as T;
    case 'clipboard:read':
      return clipboard.readText() as T;
    case 'window:reload':
      if (w && !w.webContents.isDestroyed()) {
        w.webContents.reload();
      }
      return { ok: true } as T;
    case 'fs:exists': {
      // 类型校验：非字符串路径会直接让 existsSync 抛 TypeError
      const target = typeof payload?.path === 'string' ? payload.path : '';
      if (!target) return { exists: false } as T;
      return { exists: fs.existsSync(target) } as T;
    }
    default:
      throw new Error(`Unknown native op: ${op}`);
  }
}
