import { execFile } from 'node:child_process';
import path from 'node:path';

export const editorFileExtensions = [
  '.txt', '.md', '.markdown', '.mdx', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.json', '.jsonc', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.pyw', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.cs', '.java', '.kt', '.kts', '.swift', '.m', '.mm',
  '.rb', '.php', '.lua', '.r', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.cmake', '.gradle', '.gitignore', '.editorconfig',
] as const;
const progId = 'GrayCode.SourceFile';
const capabilities = 'Software\\GrayCode\\Capabilities';
const commandKey = `Software\\Classes\\${progId}\\shell\\open\\command`;
export interface EditorRegistryValue { key: string; name: string; value: string }

export function editorRegistrationValues(executable: string): EditorRegistryValue[] {
  const command = `"${executable}" -- "%1"`;
  const values: EditorRegistryValue[] = [
    { key: `Software\\Classes\\${progId}`, name: '', value: 'GrayCode 代码文件' },
    { key: `Software\\Classes\\${progId}\\DefaultIcon`, name: '', value: `"${executable}",0` },
    { key: commandKey, name: '', value: command },
    { key: 'Software\\Classes\\Applications\\GrayCode.exe', name: 'FriendlyAppName', value: 'GrayCode' },
    { key: 'Software\\Classes\\Applications\\GrayCode.exe\\shell\\open\\command', name: '', value: command },
    { key: capabilities, name: 'ApplicationName', value: 'GrayCode' },
    { key: capabilities, name: 'ApplicationDescription', value: '使用 GrayCode 编辑代码、文本和项目文件。' },
    { key: capabilities, name: 'ApplicationIcon', value: `"${executable}",0` },
    { key: 'Software\\RegisteredApplications', name: 'GrayCode', value: capabilities },
  ];
  for (const extension of editorFileExtensions) values.push(
    { key: `${capabilities}\\FileAssociations`, name: extension, value: progId },
    { key: `Software\\Classes\\${extension}\\OpenWithProgids`, name: progId, value: '' },
    { key: 'Software\\Classes\\Applications\\GrayCode.exe\\SupportedTypes', name: extension, value: '' },
  );
  return values;
}

// 参数通过标准输入传递，不把程序路径或注册表内容插入 PowerShell 脚本。
const registryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$registry = [Microsoft.Win32.Registry]::CurrentUser
if ($request.action -eq 'read') {
  $key = $registry.OpenSubKey($request.key)
  if ($key) { try { [Console]::Out.Write([string]$key.GetValue('')) } finally { $key.Dispose() } }
} else {
  foreach ($entry in $request.values) {
    $key = $registry.CreateSubKey($entry.key)
    try { $key.SetValue([string]$entry.name, [string]$entry.value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  }
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GrayCodeShell { [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2); }'
  [GrayCodeShell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
`;

export function runEditorRegistry(request: { action: 'read'; key: string } | { action: 'write'; values: EditorRegistryValue[] }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', registryScript],
      { windowsHide: true, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Windows 编辑器注册失败：${stderr.trim() || error.message}`)); else resolve(stdout.trim());
      });
    child.stdin!.end(JSON.stringify(request));
  });
}

export class DesktopEditorRegistration {
  constructor(private readonly executable: string, private readonly packaged: boolean, private readonly platform = process.platform,
    private readonly run = runEditorRegistry) {}
  async status() {
    const supported = this.platform === 'win32' && this.packaged;
    const command = supported ? await this.run({ action: 'read', key: commandKey }) : '';
    return { supported, registered: command.toLowerCase() === `"${this.executable}" -- "%1"`.toLowerCase(),
      otherVersion: !!command && command.toLowerCase() !== `"${this.executable}" -- "%1"`.toLowerCase(),
      executable: this.executable, extensions: editorFileExtensions,
      reason: this.platform !== 'win32' ? '此入口用于 Windows 文件关联。' : !this.packaged ? '请在打包后的 GrayCode 程序中注册编辑器。' : undefined };
  }
  async register() {
    if (this.platform !== 'win32' || !this.packaged || path.basename(this.executable).toLowerCase() !== 'graycode.exe')
      throw new Error('请从 Windows 版 GrayCode.exe 注册代码编辑器。');
    // 只声明本用户可选择的应用，不改写 Windows 的默认文件选择记录。
    await this.run({ action: 'write', values: editorRegistrationValues(this.executable) });
    return this.status();
  }
}
