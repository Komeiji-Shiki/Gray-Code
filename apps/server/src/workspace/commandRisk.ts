import type { ToolEffect } from '@graycode/contracts';

/** 为审批提供操作分类，不把命令名白名单当作账号授权或进程沙箱。 */
export function shellCommandEffects(command: string): ToolEffect[] {
  const effects: ToolEffect[] = ['process_execute'];
  const deletion = /(?:^|[\s;&|()])(?:rm|rmdir|rd|del|erase|remove-item|clear-content)(?:\s|$)/i.test(command) ||
    /\bgit\s+(?:clean\b|reset\s+--hard\b|(?:branch|tag)\s+-[dD]\b)/i.test(command);
  if (deletion) effects.push('data_delete');
  if (deletion || /(?:^|[\s;&|()])(?:format|diskpart|mkfs(?:\.[\w]+)?|dd|shutdown|reboot|sudo|su|runas|reg|bcdedit|chmod|chown)(?:\s|$)/i.test(command) ||
    /\b(?:Invoke-Expression|iex|Set-ExecutionPolicy|Start-Process[^\r\n]*-Verb\s+RunAs)\b/i.test(command) ||
    /\bgit\s+push\b[^\r\n]*(?:--force|-f\b)/i.test(command)) effects.push('high_risk');
  return effects;
}

export function executableEffects(command: string, args: string[]): ToolEffect[] {
  const name = command.split(/[\\/]/).at(-1)!.replace(/\.(?:exe|cmd)$/i, '');
  if (/^(?:powershell|pwsh|cmd|bash|sh|zsh)$/i.test(name)) {
    const index = args.findIndex(arg => /^(?:-c|-command|\/c)$/i.test(arg));
    return index >= 0 ? shellCommandEffects(args.slice(index + 1).join(' ')) : ['process_execute'];
  }
  return shellCommandEffects([name, ...args].join(' '));
}
