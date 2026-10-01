import * as os from 'os';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage, type LocalizationLanguage } from '../localization/types';
import type { createShellRuntime } from './shellConfigRuntime';


export type WorkspaceRootPromptInfo = { name: string; path: string };
export interface createTerminalPromptsHost { roots(): WorkspaceRootPromptInfo[]; shells: ReturnType<typeof createShellRuntime>; getMaxOutputLines(): number; workspaceBinding?: 'task' }
/** 注入宿主服务；进程、解码状态和事件均归属于当前实例。 */
export function createTerminalPrompts(host: createTerminalPromptsHost) {
const { getDefaultShellType, getUnavailableShellsDescription } = host.shells;
const { getMaxOutputLines } = host;


function getAllWorkspaceRoots(): WorkspaceRootPromptInfo[] { return host.roots(); }

/**
 * 获取操作系统名称
 */
function getOSName(): string {
    const platform = os.platform();
    switch (platform) {
        case 'win32':
            return 'Windows';
        case 'darwin':
            return 'macOS';
        case 'linux':
            return 'Linux';
        case 'freebsd':
            return 'FreeBSD';
        default:
            return platform;
    }
}


/** 获取当前模型声明语言（zh-CN → 中文，en/ja → 英文） */
function getDeclarationLanguage(): LocalizationLanguage {
    return resolveLocalizationLanguage(getActualLanguage());
}


/** 只列出当前可选 Shell 的差异规则，共用的 POSIX 和引号说明只出现一次。 */
function getExecuteCommandShellGuidanceDescription(): string {
    const lang = getDeclarationLanguage();
    const zh = lang === 'zh-CN';
    const enabled = new Set(host.shells.getEnabledShellTypesForEnum());
    const posix = ['sh', 'bash', 'gitbash', 'wsl', 'zsh'].filter(name => enabled.has(name));
    const unavailable = getUnavailableShellsDescription();
    const output = getMaxOutputLines() === -1
        ? (zh ? '默认不截断输出。' : 'Output is not truncated by default.')
        : (zh ? `默认只保留最后 ${getMaxOutputLines()} 行输出。` : `By default only the last ${getMaxOutputLines()} lines of output are kept.`);
    return [
        zh
            ? `command 是交给所选 Shell 解析的文本，不是 argv 数组。省略 shell 或填 default 时使用 ${getDefaultShellType()}。只能选择 shell 参数列出的类型，并按所选 Shell 的语法和转义规则书写，不要混用。`
            : `command is text parsed by the selected shell, not an argv array. Omitting shell or passing default uses ${getDefaultShellType()}. Choose only a shell listed for the shell parameter, and follow that shell's syntax and escaping rules without mixing them.`,
        output,
        unavailable === '- 无' ? '' : (zh ? '已启用但可能不可用的 Shell：\n' : 'Enabled shells that may be unavailable:\n') + unavailable,
        enabled.has('powershell') ? getPowerShellGuidanceDescription(lang) : '',
        enabled.has('cmd') ? getCmdGuidanceDescription(lang) : '',
        posix.length ? getPosixShellGuidanceDescription(posix, lang) : '',
        os.platform() === 'win32' && ['bash', 'sh', 'gitbash'].some(name => enabled.has(name)) ? getGitMsysGuidanceDescription(lang) : '',
        enabled.has('wsl') ? getWslGuidanceDescription(lang) : '',
        enabled.has('zsh') ? (zh
            ? 'Zsh 的 glob、alias 和扩展规则可能不同，不要假定所有 Bash 特有语法都适用。'
            : 'Zsh glob, alias and expansion rules differ; do not assume all Bash-specific syntax works.') : '',
        getComplexCommandGuidanceDescription(lang, enabled),
        getSshGuidanceDescription(lang, enabled.has('powershell')),
    ].filter(Boolean).join('\n\n');
}


/**
 * cwd 规则同时写在参数说明里：有些模型只读参数说明，不一定完整读完主说明。
 */
function getCwdParameterDescription(workspaceRoots: WorkspaceRootPromptInfo[], isMultiRoot: boolean): string {
    const lang = getDeclarationLanguage();
    if (host.workspaceBinding === 'task') return lang === 'zh-CN'
        ? 'Shell 的启动目录，以当前任务绑定的工作区为根。省略或填 . 表示根目录，子目录写成 backend、frontend/src 这样的相对路径。命令里的文件路径相对于 cwd 书写，不要拼接工作区的绝对路径；只有工作区外的目标才在命令里写绝对路径。执行前任务必须已经选择了工作区。'
        : 'Shell startup directory, rooted at the workspace bound to this task. Omit it or use . for the root, and give subdirectories as relative paths such as backend or frontend/src. Write file paths in command relative to cwd rather than prefixing the workspace absolute path; use absolute paths in command only for targets outside the workspace. The task must have a workspace selected before the command runs.';
    const common = lang === 'zh-CN'
        ? 'cwd 是 Shell 的启动目录，不是目标文件路径。工作区内请用相对路径，不要拼接工作区的绝对路径。'
        : 'cwd is the shell startup directory, not a target file path. Inside the workspace, use relative paths instead of prefixing the workspace absolute path.';

    if (workspaceRoots.length === 0) {
        return lang === 'zh-CN'
            ? `${common}当前没有打开工作区，执行时会报错。`
            : `${common} No workspace is currently open, so running a command will fail.`;
    }

    if (isMultiRoot) {
        return lang === 'zh-CN'
            ? `${common}多根工作区要写成 "workspace_name/path" 或 "@workspace_name/path"，根目录写 workspace_name 或 @workspace_name。可用工作区：${workspaceRoots.map(w => w.name).join(', ')}。`
            : `${common} In a multi-root workspace, write it as "workspace_name/path" or "@workspace_name/path", and the root as workspace_name or @workspace_name. Available workspaces: ${workspaceRoots.map(w => w.name).join(', ')}.`;
    }

    return lang === 'zh-CN'
        ? `${common}省略 cwd 或填 "." 表示工作区根目录，子目录写成 "backend"、"frontend/src"；工作区外的目标在命令里使用绝对路径。`
        : `${common} Omit cwd or pass "." for the workspace root, and give subdirectories as "backend" or "frontend/src"; targets outside the workspace use absolute paths in the command.`;
}


function getPowerShellGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## PowerShell 规则（`shell: "powershell"`）',
            '',
            '- PowerShell 不是 Bash；不要把 Bash 语法直接写进 PowerShell。',
            '- 单引号保留字面量：`\'a|b\'`、`\'$HOME\'`、`\'$(hostname)\'`。',
            '- 双引号会展开 PowerShell 变量和子表达式：`"$env:TEMP"`、`"$(Get-Date)"`。',
            '- 环境变量写法是 `$env:NAME`，例如 `$env:TEMP`，不是 Bash 的 `$NAME`。',
            '- 未引用的 `|` 是 PowerShell 管道，示例：`Get-ChildItem | Select-Object -First 10`。',
            '- 调用路径含空格的可执行文件，用 `&`：`& "C:\\Program Files\\nodejs\\node.exe" --version`。',
            '- 调用原生可执行文件时，PowerShell 解析完还会再经过 Windows 的 argv 规则；引号和反斜杠紧贴双引号时要格外小心。',
            '- 复杂的 Node/Python/JSON/正则内容不要硬写成 `node -e "..."`，优先用单引号 here-string 写成临时脚本。'
        ].join('\n')
        : [
            '## PowerShell rules (`shell: "powershell"`)',
            '',
            '- PowerShell is not Bash; do not write Bash syntax directly into PowerShell.',
            '- Single quotes preserve literals: `\'a|b\'`, `\'$HOME\'`, `\'$(hostname)\'`.',
            '- Double quotes expand PowerShell variables and subexpressions: `"$env:TEMP"`, `"$(Get-Date)"`.',
            '- Environment variables are written as `$env:NAME`, e.g. `$env:TEMP`, not Bash\'s `$NAME`.',
            '- An unquoted `|` is a PowerShell pipeline, e.g.: `Get-ChildItem | Select-Object -First 10`.',
            '- To invoke an executable whose path contains spaces, use `&`: `& "C:\\Program Files\\nodejs\\node.exe" --version`.',
            '- When calling native exes, PowerShell parsing is followed by Windows/native argv rules; be extra careful when quotes and backslashes sit right next to double quotes.',
            '- Do not force complex Node/Python/JSON/regex content into `node -e "..."`; prefer a single-quoted here-string in a temp script.'
        ].join('\n');
}


function getCmdGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## CMD 规则（`shell: "cmd"`）',
            '',
            '- CMD 不是 PowerShell，也不是 Bash。',
            '- 环境变量写法是 `%NAME%`，例如 `%TEMP%`。',
            '- `|`、`<`、`>`、`&`、`^` 是 CMD 特殊字符。',
            '- 管道示例：`dir | findstr foo`。',
            '- 字面管道符可放进双引号：`"a|b"`；必要时使用 `a^|b`。如果已经在双引号内，不要额外写 `^|`。',
            '- 多命令串联可用 `&&`：`npm install && npm test`。',
            '- 路径含空格时使用双引号。复杂脚本通常优先改用 PowerShell 或 sh。',
            '- 不要给整条命令外面再包一层引号：cmd 启动时会去掉最外层引号，命令里如果还有引号就会解析失败。'
        ].join('\n')
        : [
            '## CMD rules (`shell: "cmd"`)',
            '',
            '- CMD is not PowerShell, and not Bash.',
            '- Environment variables are written as `%NAME%`, e.g. `%TEMP%`.',
            '- `|`, `<`, `>`, `&`, `^` are CMD special characters.',
            '- Pipeline example: `dir | findstr foo`.',
            '- A literal pipe can be put inside double quotes: `"a|b"`; when needed use `a^|b`. If already inside double quotes, do not add an extra `^|`.',
            '- Multiple commands can be chained with `&&`: `npm install && npm test`.',
            '- Use double quotes when paths contain spaces. For complex scripts, prefer PowerShell or sh.',
            '- Do not wrap the whole command in an extra outer quote (cmd strips the outermost quotes at startup; inner quotes then fail to parse).'
        ].join('\n');
}


function getPosixShellGuidanceDescription(shellNames: string[], lang: LocalizationLanguage): string {
    const shellName = shellNames.join(', ');
    return lang === 'zh-CN'
        ? [
            `## POSIX 共用规则（${shellName}）`,
            '',
            `- 使用 POSIX/${shellName} 风格语法，不要使用 PowerShell 的 \`$env:NAME\` 或 CMD 的 \`%NAME%\`。`,
            '- 单引号保留字面量：`\'a|b\'`、`\'$HOME\'`、`\'$(hostname)\'`。',
            '- 双引号允许变量展开和命令替换：`"$HOME"`、`"$(hostname)"`。',
            '- 未引用的 `|` 是管道，示例：`find . -name \'*.ts\' | head`。',
            '- 复杂多行内容优先使用强字面量 heredoc：`cat > /tmp/probe.sh <<\'EOF\' ... EOF`。',
            '- 在 Windows 上使用 Git sh/Git Bash 时，还要注意 Git/MSYS 的路径转换规则。'
        ].join('\n')
        : [
            `## Shared POSIX rules (${shellName})`,
            '',
            `- Use POSIX/${shellName}-style syntax; do not use PowerShell's \`$env:NAME\` or CMD's \`%NAME%\`.`,
            '- Single quotes preserve literals: `\'a|b\'`, `\'$HOME\'`, `\'$(hostname)\'`.',
            '- Double quotes allow variable expansion and command substitution: `"$HOME"`, `"$(hostname)"`.',
            '- An unquoted `|` is a pipeline, e.g.: `find . -name \'*.ts\' | head`.',
            '- Prefer a strong-literal heredoc for complex multi-line content: `cat > /tmp/probe.sh <<\'EOF\' ... EOF`.',
            '- If this is Git sh/Git Bash on Windows, also follow the Git/MSYS path conversion rules.'
        ].join('\n');
}


function getGitMsysGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## Git Bash / Git sh / MSYS 额外规则',
            '',
            '- Git Bash/Git sh 使用类 sh/bash 语法，但运行在 Windows/MSYS 环境中，不等于真实 Linux。',
            '- 传给 Windows 原生程序的以 `/` 开头参数可能被自动转换为 Windows 路径，例如 `/a/b/c` 可能变成 `A:/b/c`。',
            '- 正则 `/xxx/`、Linux 远端路径、Docker volume、`-L/regex/` 等要小心路径转换污染。',
            '- 必要时可在命令前设置 `MSYS_NO_PATHCONV=1`，或使用 `MSYS2_ARG_CONV_EXCL=*`。'
        ].join('\n')
        : [
            '## Git Bash / Git sh / MSYS extra rules',
            '',
            '- Git Bash/Git sh use sh/bash-like syntax but run in a Windows/MSYS environment, not real Linux.',
            '- Arguments starting with `/` passed to Windows native programs may be auto-converted to Windows paths, e.g. `/a/b/c` may become `A:/b/c`.',
            '- Be careful about path-conversion pollution for regex `/xxx/`, Linux remote paths, Docker volumes, `-L/regex/`, etc.',
            '- If needed, set `MSYS_NO_PATHCONV=1` before the command, or use `MSYS2_ARG_CONV_EXCL=*`.'
        ].join('\n');
}


function getWslGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## WSL 规则（`shell: "wsl"`）',
            '',
            '- WSL 模式通过 `wsl.exe -- bash -c <command>` 执行，命令由 WSL 内的 bash 解析。',
            '- 路径应使用 WSL/Linux 格式，例如 `/mnt/c/Users/...`，不要直接使用 PowerShell 的 `$env:TEMP`。',
            '- 从 WSL 调 Windows 程序通常需要写 `.exe`，例如 `notepad.exe`。',
            '- 如果当前环境提示 WSL 未安装或未启用，不要选择 `wsl`。'
        ].join('\n')
        : [
            '## WSL rules (`shell: "wsl"`)',
            '',
            '- WSL mode executes via `wsl.exe -- bash -c <command>`; the command is parsed by bash inside WSL.',
            '- Paths should use WSL/Linux format, e.g. `/mnt/c/Users/...`, not PowerShell\'s `$env:TEMP`.',
            '- Calling Windows programs from WSL usually requires the `.exe` suffix, e.g. `notepad.exe`.',
            '- If the current environment reports WSL is not installed or enabled, do not choose `wsl`.'
        ].join('\n');
}


function getComplexCommandGuidanceDescription(lang: LocalizationLanguage, enabled: Set<string>): string {
    return lang === 'zh-CN'
        ? [
            '## 复杂命令规则',
            '',
            '- 简单命令可以直接内联；包含多层引号、JSON、正则、Node/Python 代码、Nginx/systemd 配置、SSH 远端脚本时，不要强行写成一行。',
            ...(enabled.has('powershell') ? ['- PowerShell 推荐：用 `@\' ... \'@` 单引号 here-string 写入临时脚本，再用 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` 保存为 UTF-8 无 BOM 后执行。'] : []),
            ...(['sh','bash','gitbash','wsl','zsh'].some(name => enabled.has(name)) ? ['- sh/bash/zsh 推荐：用 `cat > /tmp/script.sh <<\'EOF\' ... EOF` 写强字面量 heredoc，再执行脚本。'] : []),
            ...(enabled.has('cmd') ? ['- CMD 不适合承载复杂多行脚本；除非用户明确要求 CMD，否则复杂逻辑优先用 PowerShell 或 sh。'] : []),
            '- 诊断引号/管道问题时，先写一个 argv/hex 探针确认目标程序实际收到什么，不要猜。'
        ].join('\n')
        : [
            '## Complex command rules',
            '',
            '- Simple commands can be inlined; do not force content with nested quotes, JSON, regex, Node/Python code, Nginx/systemd config, or SSH remote scripts into a single line.',
            ...(enabled.has('powershell') ? ['- PowerShell: prefer writing a temp script with an `@\' ... \'@` single-quoted here-string, then save it as UTF-8 without BOM via `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` and run it.'] : []),
            ...(['sh','bash','gitbash','wsl','zsh'].some(name => enabled.has(name)) ? ['- sh/bash/zsh: prefer writing a strong-literal heredoc `cat > /tmp/script.sh <<\'EOF\' ... EOF`, then run the script.'] : []),
            ...(enabled.has('cmd') ? ['- CMD is not suited for complex multi-line scripts; unless the user explicitly asks for CMD, prefer PowerShell or sh for complex logic.'] : []),
            '- When diagnosing quote/pipe issues, first write an argv/hex probe to confirm what the target program actually receives; do not guess.'
        ].join('\n');
}


function getSshGuidanceDescription(lang: LocalizationLanguage, powershell: boolean): string {
    return lang === 'zh-CN'
        ? [
            '## SSH 多层解析规则',
            '',
            '- SSH 至少有两层解析：本地 shell 先解析整条 `ssh ...` 命令；远端用户 shell 再解析远端命令。远端命令不是 argv 直达目标程序。',
            ...(powershell ? ['- 在 PowerShell 中调用 SSH，外层单引号只能阻止本地 PowerShell 展开；远端 shell 仍会解释 `$HOME`、`$(hostname)`、`|` 等。'] : []),
            ...(powershell ? ['- 在 PowerShell → ssh → 远端 bash 这条链路中，如果远端 shell 需要用双引号保护参数，PowerShell 命令里通常要写 `\\"`；要让远端收到字面的 `$HOME`，写 `\\"\\$HOME\\"`；字面的 `$(hostname)` 写 `\\"\\$(hostname)\\"`。'] : []),
            '- 复杂远端操作不要硬塞一行：优先本地生成脚本，`scp` 上传到远端 `/tmp/...`，`ssh` 执行远端脚本，完成后清理脚本。',
            ...(powershell ? ['- Windows 用户目录 SSH key 示例：`ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" root@host \'hostname\'`。'] : []),
        ].join('\n')
        : [
            '## SSH multi-layer parsing rules',
            '',
            '- SSH has at least two parsing layers: the local shell first parses the whole `ssh ...` command; the remote user shell then parses the remote command. The remote command is not passed as argv directly to the target program.',
            ...(powershell ? ['- When calling SSH from PowerShell, an outer single quote only stops local PowerShell expansion; the remote shell still interprets `$HOME`, `$(hostname)`, `|`, etc.'] : []),
            ...(powershell ? ['- In a PowerShell → ssh → remote bash chain, if the remote shell needs double quotes to protect arguments, the PowerShell command usually needs `\\"`; to pass a literal `$HOME` to the remote side, write `\\"\\$HOME\\"`, and for a literal `$(hostname)` write `\\"\\$(hostname)\\"`.'] : []),
            '- Do not cram complex remote operations into one line: prefer generating the script locally, `scp` it to `/tmp/...` on the remote, `ssh` to run it, then clean up the script.',
            ...(powershell ? ['- Windows SSH key example in the user directory: `ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" root@host \'hostname\'`.'] : []),
        ].join('\n');
}
return { getAllWorkspaceRoots, getOSName, getExecuteCommandShellGuidanceDescription, getCwdParameterDescription };
}
