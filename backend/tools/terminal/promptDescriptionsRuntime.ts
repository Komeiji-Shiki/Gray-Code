import * as os from 'os';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage, type LocalizationLanguage } from '../localization/types';
import type { createShellRuntime } from './shellConfigRuntime';


export type WorkspaceRootPromptInfo = { name: string; path: string };
export interface createTerminalPromptsHost { roots(): WorkspaceRootPromptInfo[]; shells: ReturnType<typeof createShellRuntime>; getMaxOutputLines(): number; workspaceBinding?: 'task' }
type Localized = { zh: string; en: string };
/** full 用于默认 Shell 的完整规则；brief 只保留启用但非默认的 Shell 最容易踩的坑。 */
interface ShellRules { title: Localized; full: Localized[]; brief: Localized }

const POSIX_SHELLS = ['sh', 'bash', 'gitbash', 'wsl', 'zsh'];
const MSYS_SHELLS = ['bash', 'sh', 'gitbash'];

const POWERSHELL_RULES: ShellRules = {
    title: { zh: 'PowerShell 规则', en: 'PowerShell rules' },
    full: [
        { zh: '单引号保留字面量；双引号展开变量与 `$()` 子表达式。环境变量用 `$env:NAME`，未引用的 `|` 是管道。',
            en: 'Single quotes preserve literals; double quotes expand variables and `$()` subexpressions. Environment variables use `$env:NAME`; unquoted `|` is a pipeline.' },
        { zh: '调用路径含空格的可执行文件，用 `&`：`& "C:\\Program Files\\nodejs\\node.exe" --version`。',
            en: 'To invoke an executable whose path contains spaces, use `&`: `& "C:\\Program Files\\nodejs\\node.exe" --version`.' },
        { zh: '原生程序的参数还会经过 Windows argv 解析，注意双引号附近的引号与反斜杠。复杂内容用 `@\' ... \'@` 单引号 here-string 写入脚本。',
            en: 'Native arguments also pass through Windows argv parsing; take care with quotes and backslashes near double quotes. Write complex content to a script using an `@\' ... \'@` single-quoted here-string.' },
    ],
    brief: { zh: 'PowerShell：变量用 `$env:NAME`，双引号会展开 `$()`；调用路径含空格的程序用 `&`。',
        en: 'PowerShell: variables use `$env:NAME` and double quotes expand `$()`; invoke executables with spaces in the path using `&`.' },
};

const CMD_RULES: ShellRules = {
    title: { zh: 'CMD 规则', en: 'CMD rules' },
    full: [
        { zh: '环境变量用 `%NAME%`；`|`、`<`、`>`、`&`、`^` 是特殊字符，多命令用 `&&` 串联。',
            en: 'Environment variables use `%NAME%`; `|`, `<`, `>`, `&`, `^` are special characters. Chain commands with `&&`.' },
        { zh: '字面管道符用 `"a|b"` 或 `a^|b`，双引号内不额外加 `^`。含空格的路径用双引号。',
            en: 'Use `"a|b"` or `a^|b` for a literal pipe; do not add `^` inside double quotes. Quote paths containing spaces.' },
        { zh: '不要给整条命令再包外层引号，cmd 启动时会剥离它。复杂多行脚本优先选 PowerShell 或 sh。',
            en: 'Do not add outer quotes around the entire command; cmd strips them at startup. Prefer PowerShell or sh for complex multiline scripts.' },
    ],
    brief: { zh: 'CMD：变量用 `%NAME%`，`|<>&^` 是特殊字符，字面量用 `^` 转义；不要给整条命令再包外层引号。',
        en: 'CMD: variables use `%NAME%`; `|<>&^` are special and escaped with `^`; never wrap the whole command in outer quotes.' },
};

const POSIX_RULES: ShellRules = {
    title: { zh: 'POSIX 共用规则', en: 'Shared POSIX rules' },
    full: [
        { zh: '单引号保留字面量；双引号允许 `$NAME` 变量展开与 `$(hostname)` 命令替换，未引用的 `|` 是管道。',
            en: 'Single quotes preserve literals; double quotes allow `$NAME` expansion and `$(hostname)` substitution. Unquoted `|` is a pipeline.' },
        { zh: '多行字面内容用引用分隔符的 heredoc：`cat > /tmp/script.sh <<\'EOF\' ... EOF`。',
            en: 'For multiline literal content, quote the heredoc delimiter: `cat > /tmp/script.sh <<\'EOF\' ... EOF`.' },
    ],
    brief: { zh: 'POSIX：单引号保留字面量，双引号展开 `$NAME` 与 `$(...)`；多行内容用 `<<\'EOF\'` heredoc。',
        en: 'POSIX: single quotes are literal, double quotes expand `$NAME` and `$(...)`; use a `<<\'EOF\'` heredoc for multiline content.' },
};

const MSYS_RULES: ShellRules = {
    title: { zh: 'Git Bash / MSYS 规则', en: 'Git Bash / MSYS rules' },
    full: [
        { zh: 'Windows/MSYS 会转换传给原生程序的 `/` 开头参数，可能影响正则、远端路径和 Docker volume。需要保留原文时设置 `MSYS_NO_PATHCONV=1` 或 `MSYS2_ARG_CONV_EXCL=*`。',
            en: 'Windows/MSYS may convert `/`-prefixed arguments passed to native programs, affecting regex, remote paths and Docker volumes. Preserve them with `MSYS_NO_PATHCONV=1` or `MSYS2_ARG_CONV_EXCL=*` when needed.' },
    ],
    brief: { zh: 'Git Bash / MSYS：以 `/` 开头的参数会被转换成 Windows 路径，需要原样保留时设 `MSYS_NO_PATHCONV=1`。',
        en: 'Git Bash / MSYS: `/`-prefixed arguments are converted to Windows paths; set `MSYS_NO_PATHCONV=1` to keep them literal.' },
};

const WSL_RULES: ShellRules = {
    title: { zh: 'WSL 规则', en: 'WSL rules' },
    full: [
        { zh: 'WSL 模式通过 `wsl.exe -- bash -c <command>` 执行，命令由 WSL 内的 bash 解析。',
            en: 'WSL mode executes via `wsl.exe -- bash -c <command>`; the command is parsed by bash inside WSL.' },
        { zh: '路径用 WSL/Linux 格式，例如 `/mnt/c/Users/...`；调用 Windows 程序通常需要 `.exe`。',
            en: 'Use WSL/Linux paths such as `/mnt/c/Users/...`; Windows programs usually need `.exe`.' },
    ],
    brief: { zh: 'WSL：命令由 WSL 内的 bash 解析，路径用 `/mnt/c/...`，调用 Windows 程序要带 `.exe`。',
        en: 'WSL: bash inside WSL parses the command; use `/mnt/c/...` paths and add `.exe` for Windows programs.' },
};

const ZSH_RULE: Localized = { zh: 'Zsh：glob、alias 和扩展规则与 Bash 不同，不要假定 Bash 特有语法都可用。',
    en: 'Zsh: glob, alias and expansion rules differ from Bash; do not assume Bash-specific syntax works.' };
const ZSH_RULES: ShellRules = { title: { zh: 'Zsh 规则', en: 'Zsh rules' }, full: [ZSH_RULE], brief: ZSH_RULE };

/** 默认 Shell 解析命令时会叠加的规则组；POSIX 系 Shell 还带各自宿主的路径规则。 */
function rulesForShell(shell: string): ShellRules[] {
    if (shell === 'powershell') return [POWERSHELL_RULES];
    if (shell === 'cmd') return [CMD_RULES];
    if (!POSIX_SHELLS.includes(shell)) return [];
    return [POSIX_RULES,
        ...(os.platform() === 'win32' && MSYS_SHELLS.includes(shell) ? [MSYS_RULES] : []),
        ...(shell === 'wsl' ? [WSL_RULES] : []),
        ...(shell === 'zsh' ? [ZSH_RULES] : [])];
}

/** 注入宿主服务；进程、解码状态和事件均归属于当前实例。 */
export function createTerminalPrompts(host: createTerminalPromptsHost) {
const { getDefaultShellType } = host.shells;
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


/** 默认 Shell 写完整规则，其他启用的 Shell 各留一行要点；可选 Shell 本身由 shell 参数的枚举表达。 */
function getExecuteCommandShellGuidanceDescription(): string {
    const zh = getDeclarationLanguage() === 'zh-CN';
    const text = (value: Localized) => zh ? value.zh : value.en;
    const defaultShell = getDefaultShellType();
    const enabled = host.shells.getEnabledShellTypesForEnum().filter(name => name !== 'default');
    const primary = rulesForShell(defaultShell);
    const others = [...new Set(enabled.flatMap(rulesForShell))].filter(rules => !primary.includes(rules));
    const maxOutputLines = getMaxOutputLines();
    const output = maxOutputLines === -1
        ? (zh ? '默认不截断输出。' : ' Output is not truncated by default.')
        : (zh ? `默认只保留最后 ${maxOutputLines} 行输出。` : ` By default only the last ${maxOutputLines} lines of output are kept.`);
    const powershell = enabled.includes('powershell');
    const ssh = zh
        ? `经 SSH 执行时远端 Shell 会再解析一次命令${powershell ? '，PowerShell 外层单引号只阻止本地展开，远端仍会解释 \`$HOME\` 和 \`|\`' : ''}；复杂远端操作先生成脚本，用 scp 上传后执行并清理。`
        : `Over SSH the remote shell parses the command again${powershell ? '; outer PowerShell single quotes only stop local expansion, so the remote side still interprets \`$HOME\` and \`|\`' : ''}. For complex remote work, generate a script, upload it with scp, run it, then clean up.`;
    return [
        (zh
            ? `Shell 模式下 command 是交给所选 Shell 解析的文本；省略 shell 或填 default 时使用 ${defaultShell}。按所选 Shell 的语法转义，不要混用。`
            : `In shell mode, command is text parsed by the selected shell; omitting shell or passing default uses ${defaultShell}. Escape for the selected shell's syntax without mixing shells.`) + output,
        ...primary.map(rules => `## ${text(rules.title)}${zh ? '（默认 Shell）' : ' (default shell)'}\n${rules.full.map(rule => `- ${text(rule)}`).join('\n')}`),
        others.length ? `## ${zh ? '其他可选 Shell' : 'Other shells'}\n${others.map(rules => `- ${text(rules.brief)}`).join('\n')}` : '',
        `## ${zh ? '复杂命令' : 'Complex commands'}\n- ${zh
            ? '多层引号、JSON、正则或代码先写入 UTF-8 无 BOM 临时脚本再执行；转义有疑问时用 argv/hex 探针确认程序实际收到的参数。'
            : 'Write nested quotes, JSON, regex or code to a UTF-8 temporary script without BOM before running it; for escaping doubts, use an argv/hex probe to see what the program receives.'}\n- ${ssh}`,
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


return { getAllWorkspaceRoots, getOSName, getExecuteCommandShellGuidanceDescription, getCwdParameterDescription };
}
