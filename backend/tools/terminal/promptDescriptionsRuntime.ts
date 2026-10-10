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
    const maxOutputLines = getMaxOutputLines();
    const output = maxOutputLines === -1
        ? (zh ? '默认不截断输出。' : 'Output is not truncated by default.')
        : (zh ? `默认只保留最后 ${maxOutputLines} 行输出。` : `By default only the last ${maxOutputLines} lines of output are kept.`);
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
        getComplexCommandGuidanceDescription(lang),
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
            '- 单引号保留字面量；双引号展开变量与 `$()` 子表达式。环境变量用 `$env:NAME`，未引用的 `|` 是管道。',
            '- 调用路径含空格的可执行文件，用 `&`：`& "C:\\Program Files\\nodejs\\node.exe" --version`。',
            '- 原生程序的参数还会经过 Windows argv 解析，注意双引号附近的引号与反斜杠。复杂内容用 `@\' ... \'@` 单引号 here-string 写入脚本。'
        ].join('\n')
        : [
            '## PowerShell rules (`shell: "powershell"`)',
            '- Single quotes preserve literals; double quotes expand variables and `$()` subexpressions. Environment variables use `$env:NAME`; unquoted `|` is a pipeline.',
            '- To invoke an executable whose path contains spaces, use `&`: `& "C:\\Program Files\\nodejs\\node.exe" --version`.',
            '- Native arguments also pass through Windows argv parsing; take care with quotes and backslashes near double quotes. Write complex content to a script using an `@\' ... \'@` single-quoted here-string.'
        ].join('\n');
}


function getCmdGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## CMD 规则（`shell: "cmd"`）',
            '- 环境变量用 `%NAME%`；`|`、`<`、`>`、`&`、`^` 是特殊字符，多命令用 `&&` 串联。',
            '- 字面管道符用 `"a|b"` 或 `a^|b`，双引号内不额外加 `^`。含空格的路径用双引号。',
            '- 不要给整条命令再包外层引号，cmd 启动时会剥离它。复杂多行脚本优先选 PowerShell 或 sh。'
        ].join('\n')
        : [
            '## CMD rules (`shell: "cmd"`)',
            '- Environment variables use `%NAME%`; `|`, `<`, `>`, `&`, `^` are special characters. Chain commands with `&&`.',
            '- Use `"a|b"` or `a^|b` for a literal pipe; do not add `^` inside double quotes. Quote paths containing spaces.',
            '- Do not add outer quotes around the entire command; cmd strips them at startup. Prefer PowerShell or sh for complex multiline scripts.'
        ].join('\n');
}


function getPosixShellGuidanceDescription(shellNames: string[], lang: LocalizationLanguage): string {
    const shellName = shellNames.join(', ');
    return lang === 'zh-CN'
        ? [
            `## POSIX 共用规则（${shellName}）`,
            '- 单引号保留字面量；双引号允许 `$NAME` 变量展开与 `$(hostname)` 命令替换，未引用的 `|` 是管道。',
            '- 多行字面内容用引用分隔符的 heredoc：`cat > /tmp/script.sh <<\'EOF\' ... EOF`。'
        ].join('\n')
        : [
            `## Shared POSIX rules (${shellName})`,
            '- Single quotes preserve literals; double quotes allow `$NAME` expansion and `$(hostname)` substitution. Unquoted `|` is a pipeline.',
            '- For multiline literal content, quote the heredoc delimiter: `cat > /tmp/script.sh <<\'EOF\' ... EOF`.'
        ].join('\n');
}


function getGitMsysGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## Git Bash / Git sh / MSYS 额外规则',
            '- Windows/MSYS 会转换传给原生程序的 `/` 开头参数，可能影响正则、远端路径和 Docker volume。需要保留原文时设置 `MSYS_NO_PATHCONV=1` 或 `MSYS2_ARG_CONV_EXCL=*`。'
        ].join('\n')
        : [
            '## Git Bash / Git sh / MSYS extra rules',
            '- Windows/MSYS may convert `/`-prefixed arguments passed to native programs, affecting regex, remote paths and Docker volumes. Preserve them with `MSYS_NO_PATHCONV=1` or `MSYS2_ARG_CONV_EXCL=*` when needed.'
        ].join('\n');
}


function getWslGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## WSL 规则（`shell: "wsl"`）',
            '- WSL 模式通过 `wsl.exe -- bash -c <command>` 执行，命令由 WSL 内的 bash 解析。',
            '- 路径用 WSL/Linux 格式，例如 `/mnt/c/Users/...`；调用 Windows 程序通常需要 `.exe`。环境提示 WSL 不可用时不要选择它。'
        ].join('\n')
        : [
            '## WSL rules (`shell: "wsl"`)',
            '- WSL mode executes via `wsl.exe -- bash -c <command>`; the command is parsed by bash inside WSL.',
            '- Use WSL/Linux paths such as `/mnt/c/Users/...`; Windows programs usually need `.exe`. Do not select WSL if the environment reports it unavailable.'
        ].join('\n');
}


function getComplexCommandGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## 复杂命令规则',
            '- 多层引号、JSON、正则或代码先写入 UTF-8 无 BOM 临时脚本再执行。遇到转义问题，用 argv/hex 探针确认目标程序实际收到的参数。'
        ].join('\n')
        : [
            '## Complex command rules',
            '- Write nested quotes, JSON, regex or code to a UTF-8 temporary script without BOM before running it. For escaping issues, use an argv/hex probe to inspect the received arguments.'
        ].join('\n');
}


function getSshGuidanceDescription(lang: LocalizationLanguage, powershell: boolean): string {
    return lang === 'zh-CN'
        ? [
            '## SSH 多层解析规则',
            '- 本地 Shell 与远端 Shell 会依次解析命令，远端命令不是 argv 直传。',
            ...(powershell ? ['- PowerShell 的外层单引号只阻止本地展开，远端仍解释 `$HOME`、`$(hostname)` 和 `|`；分别按两侧语法转义。'] : []),
            '- 复杂远端操作优先生成脚本，用 `scp` 上传、`ssh` 执行，完成后清理。',
        ].join('\n')
        : [
            '## SSH multi-layer parsing rules',
            '- Local and remote shells parse the command in order; the remote command is not passed directly as argv.',
            ...(powershell ? ['- Outer PowerShell single quotes stop local expansion only; the remote shell still interprets `$HOME`, `$(hostname)` and `|`. Escape for each shell separately.'] : []),
            '- For complex remote operations, generate a script, upload with `scp`, execute with `ssh`, then clean up.',
        ].join('\n');
}
return { getAllWorkspaceRoots, getOSName, getExecuteCommandShellGuidanceDescription, getCwdParameterDescription };
}
