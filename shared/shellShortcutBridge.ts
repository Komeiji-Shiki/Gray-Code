export const SHELL_SHORTCUTS_MESSAGE = 'graycode.shellShortcuts';
export const SHELL_SHORTCUT_MESSAGE = 'graycode.shellShortcut';

export interface ShellShortcutBinding {
  command: string;
  key: string;
  primary?: boolean;
  shift?: boolean;
  accelerator: string;
}

interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** iframe 只匹配外壳下发的组合，不维护第二份键位表。 */
export function matchShellShortcut(event: ShortcutKeyEvent, bindings: readonly ShellShortcutBinding[]): ShellShortcutBinding | undefined {
  if (event.altKey) return;
  return bindings.find(binding => event.key.toLowerCase() === binding.key
    && (event.ctrlKey || event.metaKey) === !!binding.primary && event.shiftKey === !!binding.shift);
}
