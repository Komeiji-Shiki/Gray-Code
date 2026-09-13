import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LanguageServerDefinition, LanguageServiceInfo } from '@graycode/contracts';

export interface RuntimeLanguageServer extends LanguageServerDefinition {
  companionId?: string;
  internal?: boolean;
  synchronizedLanguages?: string[];
}
interface Entry { definition: RuntimeLanguageServer; info: LanguageServiceInfo }

const bundledEntry = (file: string) => require.resolve(file);
const typescriptLanguages = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

/** 只查找已安装的程序；检测不会安装 SDK，也不会为不存在的服务创建失败进程。 */
export function executable(command: string): string | undefined {
  const taskHome = os.homedir();
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), process.env.GOBIN,
    path.join(process.env.GOPATH ?? path.join(taskHome, 'go'), 'bin'), path.join(process.env.CARGO_HOME ?? path.join(taskHome, '.cargo'), 'bin'),
    path.join(taskHome, '.dotnet', 'tools')].filter((value): value is string => !!value);
  const suffixes = process.platform === 'win32' && !path.extname(command) ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const directory of path.isAbsolute(command) ? [''] : directories) for (const suffix of suffixes) {
    const candidate = path.resolve(directory, command + suffix);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 继续检查其他 PATH 条目。 */ }
  }
  return undefined;
}

/** 只在系统声明的 PowerShell 模块路径和 PATH 中检测服务，不依赖其他编辑器的私有安装目录。 */
function powerShellScript(): string | undefined {
  const onPath = executable('Start-EditorServices.ps1');
  if (onPath) return onPath;
  for (const directory of (process.env.PSModulePath ?? '').split(path.delimiter).filter(Boolean)) {
    const moduleRoot = path.join(directory, 'PowerShellEditorServices');
    const candidates = [path.join(moduleRoot, 'Start-EditorServices.ps1')];
    try {
      const versions = fs.readdirSync(moduleRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+\./.test(entry.name))
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
      candidates.push(...versions.map(entry => path.join(moduleRoot, entry.name, 'Start-EditorServices.ps1')));
    } catch { /* 该模块目录尚未安装。 */ }
    for (const candidate of candidates) try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* 检查下一个模块版本。 */ }
  }
  return undefined;
}

/** 内置服务随程序交付，系统服务的检测结果在用户重新检测时刷新。 */
export class LanguageServerCatalog {
  private entries?: Entry[];
  private collected(): Entry[] {
    const node = (id: string, name: string, languages: string[], file: string, args: string[] = ['--stdio'],
      extra: Partial<RuntimeLanguageServer> = {}, requirement?: string): Entry => ({
      definition: { id, name, languages, command: process.execPath, args: [bundledEntry(file), ...args], ...extra },
      info: { id, name, languages, source: 'bundled', available: true, requirement },
    });
    const typescriptOptions = { hostInfo: 'GrayCode', disableAutomaticTypingAcquisition: true,
      tsserver: { path: bundledEntry('typescript/lib/tsserver.js'), useSyntaxServer: 'never' } };
    const entries: Entry[] = [
      node('typescript', 'TypeScript / JavaScript', typescriptLanguages, 'typescript-language-server/lib/cli.mjs', ['--stdio'], { initializationOptions: typescriptOptions }),
      node('python', 'Python', ['python'], 'pyright/langserver.index.js'),
      node('html', 'HTML', ['html'], 'vscode-langservers-extracted/bin/vscode-html-language-server', ['--stdio'], { initializationOptions: { provideFormatter: true } }),
      node('css', 'CSS / SCSS / Less', ['css', 'scss', 'less'], 'vscode-langservers-extracted/bin/vscode-css-language-server', ['--stdio'], { initializationOptions: { provideFormatter: true } }),
      node('json', 'JSON / JSONC', ['json', 'jsonc'], 'vscode-langservers-extracted/bin/vscode-json-language-server', ['--stdio'], { initializationOptions: { provideFormatter: true } }),
      node('yaml', 'YAML', ['yaml'], 'yaml-language-server/bin/yaml-language-server'),
      node('bash', 'Shell / Bash', ['shellscript'], 'bash-language-server/out/cli.js', ['start'], {}, '安装 ShellCheck 后还可使用代码检查，安装 shfmt 后可使用格式化。'),
      node('vue', 'Vue', ['vue'], '@vue/language-server/bin/vue-language-server.js', ['--stdio', '--tsdk=' + path.dirname(bundledEntry('typescript/lib/tsserver.js'))], { companionId: '@graycode/vue-typescript' }),
      node('svelte', 'Svelte', ['svelte'], 'svelte-language-server/bin/server.js'),
      node('@graycode/vue-typescript', 'Vue TypeScript', [], 'typescript-language-server/lib/cli.mjs', ['--stdio'], { internal: true,
        synchronizedLanguages: [...typescriptLanguages, 'vue'], initializationOptions: { ...typescriptOptions,
          plugins: [{ name: '@vue/typescript-plugin', location: path.dirname(bundledEntry('@vue/typescript-plugin/package.json')), languages: ['vue'] }] } }),
    ];
    const system = (id: string, name: string, languages: string[], command: string, args: string[], requirement: string, documentationUrl: string) => {
      const found = executable(command);
      const definition = { id, name, languages, command: found ?? command, args };
      entries.push({ definition, info: { id, name, languages, source: 'system', available: !!found,
        command: definition.command, requirement, documentationUrl, configurationTemplate: definition } });
    };
    system('gopls', 'Go', ['go'], 'gopls', [], '需要 Go 开发环境和 gopls。', 'https://go.dev/gopls/');
    system('rust-analyzer', 'Rust', ['rust'], 'rust-analyzer', [], '需要 Rust 工具链及 rust-analyzer 组件。', 'https://rust-analyzer.github.io/book/installation.html');
    system('clangd', 'C / C++', ['c', 'cpp', 'objective-c', 'objective-cpp'], 'clangd', [], '需要 clangd；项目编译参数可通过 compile_commands.json 提供。', 'https://clangd.llvm.org/installation.html');
    system('jdtls', 'Java', ['java'], 'jdtls', [], '需要 Java 开发环境及 Eclipse JDT Language Server。', 'https://github.com/eclipse-jdtls/eclipse.jdt.ls');
    system('csharp-ls', 'C#', ['csharp'], 'csharp-ls', [], '需要 .NET SDK 及 csharp-ls。', 'https://github.com/razzmatazz/csharp-language-server');
    system('lua-language-server', 'Lua', ['lua'], 'lua-language-server', [], '需要 Lua Language Server。', 'https://luals.github.io/');
    system('intelephense', 'PHP', ['php'], 'intelephense', ['--stdio'], '需要已安装的 Intelephense 语言服务。', 'https://intelephense.com/');
    system('sql-language-server', 'SQL', ['sql'], 'sql-language-server', ['up', '--method', 'stdio'], '需要 sql-language-server；数据库连接和检查规则在服务设置中配置。', 'https://github.com/joe-re/sql-language-server');
    system('marksman', 'Markdown', ['markdown'], 'marksman', ['server'], '需要 Marksman。项目使用 Git 根目录或 .marksman.toml 组织跨文件链接。', 'https://github.com/artempyanykh/marksman/blob/main/docs/install.md');
    const powershell = executable('pwsh'), script = powerShellScript();
    const definition: RuntimeLanguageServer = { id: 'powershell', name: 'PowerShell', languages: ['powershell'], command: powershell ?? 'pwsh',
      args: ['-NoLogo', '-NoProfile', '-File', script ?? 'Start-EditorServices.ps1', '-Stdio', '-LanguageServiceOnly'] };
    entries.push({ definition, info: { id: definition.id, name: definition.name, languages: definition.languages, source: 'system',
      available: !!powershell && !!script, command: definition.command, configurationTemplate: definition,
      requirement: '需要 PowerShell 7 和 PowerShell Editor Services。可将启动脚本所在目录加入 PATH，或在自定义配置中填写脚本完整路径。',
      documentationUrl: 'https://github.com/PowerShell/PowerShellEditorServices#usage' } });
    return entries;
  }
  all(custom: LanguageServerDefinition[], refresh = false): Entry[] {
    if (!this.entries || refresh) this.entries = this.collected();
    const ids = new Set(custom.map(item => item.id));
    return [...custom.map(({ id, name, languages, command, args, initializationOptions, settings }) => ({
      // 自定义配置只投影公开启动选项，内部辅助服务关系由宿主管理。
      definition: { id, name, languages, command, args, initializationOptions, settings },
      info: { id, name, languages, source: 'custom' as const, available: true, command, requirement: '按自定义配置启动；以实际启动状态为准。' } })),
      ...this.entries.filter(entry => !ids.has(entry.definition.id))];
  }
}
