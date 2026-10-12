import type { ShellShortcutBinding } from '../../../shared/shellShortcutBridge';

// 键位由外壳统一分派；原生菜单只使用 accelerator 显示提示。
export const shellShortcuts = {
  newConversation: { key: 'n', primary: true, accelerator: 'CmdOrCtrl+N' },
  toggleSidebar: { key: 'b', primary: true, accelerator: 'CmdOrCtrl+B' },
  projectSearch: { key: 'f', primary: true, shift: true, accelerator: 'CmdOrCtrl+Shift+F' },
  'debug.continue': { key: 'f5', accelerator: 'F5' },
  'debug.stop': { key: 'f5', shift: true, accelerator: 'Shift+F5' },
  'debug.next': { key: 'f10', accelerator: 'F10' },
  'debug.stepIn': { key: 'f11', accelerator: 'F11' },
  'debug.stepOut': { key: 'f11', shift: true, accelerator: 'Shift+F11' },
} satisfies Record<string, Omit<ShellShortcutBinding, 'command'>>;
