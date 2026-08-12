/**
 * execute_command tool description & prompt generation
 *
 * Split from execute_command.ts: dynamic tool description (OS/workspace
 * info), shell usage guidance prompts, cwd rules, and per-shell parsing
 * rule descriptions.
 *
 * 国际化：所有模型可见的说明文本按进程级实际语言生成——
 * zh-CN 输出中文，en/ja 输出英文（ja 本阶段映射到英文说明）。
 * 关键 shell 解析规则（引号/管道/heredoc 等）中英文都保留，不删减。
 */

import * as os from 'os';
import * as vscode from 'vscode';
import { getDefaultShellName, getDefaultShellType, getUnavailableShellsDescription } from './shellConfig';
import { getMaxOutputLines } from './outputDecoder';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage, type LocalizationLanguage } from '../localization/types';

export type WorkspaceRootPromptInfo = { name: string; path: string };

/**
 * 获取工作区根目录路径（默认返回第一个）
 */
function getWorkspaceRootPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * 获取所有工作区路径
 */
export function getAllWorkspaceRoots(): WorkspaceRootPromptInfo[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];
    return folders.map(f => ({ name: f.name, path: f.uri.fsPath }));
}

/**
 * 根据名称获取工作区路径
 */
function getWorkspacePathByName(name: string): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return undefined;
    const folder = folders.find(f => f.name.toLowerCase() === name.toLowerCase());
    return folder?.uri.fsPath;
}

/**
 * 获取操作系统名称
 */
export function getOSName(): string {
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

/**
 * 输出截断配置的中英文描述片段（动态值保持运行时插值）。
 */
function getMaxOutputLinesText(lang: LocalizationLanguage): string {
    const maxOutputLines = getMaxOutputLines();
    // maxOutputLines === -1 表示不截断：返回完整句子，由调用处直接拼成完整条目。
    if (maxOutputLines === -1) {
        return lang === 'zh-CN' ? '默认不截断输出' : 'by default, output is not truncated';
    }
    return lang === 'zh-CN' ? `最后 ${maxOutputLines}` : `last ${maxOutputLines} lines`;
}

/**
 * execute_command 的 Shell 使用提示词（中英文）。
 *
 * 设计原则：保持 execute_command 作为 pure shell 工具，不新增 argv/script/stdin 模式；
 * 通过明确每种 shell 的解析规则降低模型误用概率。
 * 中英文都保留引号/管道等关键解析规则，不删减，也不新增篇幅。
 */
export function getExecuteCommandShellGuidanceDescription(
    workspaceRoots: WorkspaceRootPromptInfo[],
    isMultiRoot: boolean
): string {
    const lang = getDeclarationLanguage();
    const defaultShellType = getDefaultShellType();
    const maxOutputLinesValue = getMaxOutputLines();
    const maxOutputLines = getMaxOutputLinesText(lang);

    // shellConfig 的 getUnavailableShellsDescription 只有中文本地化（'- 无'），
    // 这里在英文分支做最小映射，避免英文请求收到中英混排。
    const unavailableShells = getUnavailableShellsDescription();
    const unavailableText = lang === 'zh-CN'
        ? unavailableShells
        : unavailableShells === '- 无'
            ? '- None'
            : unavailableShells;

    if (lang === 'zh-CN') {
        return [
            '## 重要语义',
            '',
            '`command` 是一段 Shell 文本，不是 argv 数组。Function Calling 只负责把字符串交给工具；随后该字符串会被 `shell` 参数指定的 Shell 继续解析。你必须按照所选 Shell 的语法书写命令。',
            '',
            getCwdGuidanceDescription(workspaceRoots, isMultiRoot, lang),
            '',
            '## Shell 选择规则',
            '',
            `- 如果不传 \`shell\` 或设置为 \`default\`，将使用当前默认 Shell：\`${defaultShellType}\`（${getDefaultShellName()}）。`,
            '- 当前只能选择 "已启用 Shell 列表" 和参数 enum 中出现的 shell；不要选择不可用的 shell。',
            '- Windows 文件系统、PowerShell cmdlet、对象管道：优先选择 `powershell`。',
            '- CMD 内置命令、批处理兼容行为：选择 `cmd`。',
            '- POSIX sh 语法、`grep` / `sed` / `find` / `head`、heredoc：选择 `sh` / `bash` / `gitbash`。',
            '- macOS 默认通常是 `zsh`；Linux 默认通常是 `bash`。',
            (maxOutputLinesValue === -1
                ? '- 默认不截断输出'
                : '- 返回输出默认只保留' + maxOutputLines + '行') + '；长任务请设置 `timeout`，单位毫秒，`0` 表示不超时。',
            '',
            '## 当前已配置但不可用的 Shell',
            '',
            unavailableText,
            '',
            getPowerShellGuidanceDescription(lang),
            '',
            getCmdGuidanceDescription(lang),
            '',
            getPosixShellGuidanceDescription('sh', lang),
            '',
            getPosixShellGuidanceDescription('bash', lang),
            '',
            getGitMsysGuidanceDescription(lang),
            '',
            getWslGuidanceDescription(lang),
            '',
            getZshGuidanceDescription(lang),
            '',
            getPipeGuidanceDescription(lang),
            '',
            getComplexCommandGuidanceDescription(lang),
            '',
            getSshGuidanceDescription(lang)
        ].join('\n');
    }

    return [
        '## Important semantics',
        '',
        '`command` is a Shell text string, not an argv array. Function Calling only hands the string to the tool; the string is then parsed by the shell specified in the `shell` parameter. You must write the command following the selected shell\'s syntax.',
        '',
        getCwdGuidanceDescription(workspaceRoots, isMultiRoot, lang),
        '',
        '## Shell selection rules',
        '',
        `- If \`shell\` is omitted or set to \`default\`, the current default shell is used: \`${defaultShellType}\` (${getDefaultShellName()}).`,
        '- You can only choose shells listed in the "Enabled Shells" list and the parameter enum; do not choose unavailable shells.',
        '- Windows filesystem, PowerShell cmdlets, object pipelines: prefer `powershell`.',
        '- CMD built-in commands and batch-compatible behavior: choose `cmd`.',
        '- POSIX sh syntax, `grep` / `sed` / `find` / `head`, heredoc: choose `sh` / `bash` / `gitbash`.',
        '- macOS usually defaults to `zsh`; Linux usually defaults to `bash`.',
        (maxOutputLinesValue === -1
            ? '- By default, output is not truncated'
            : `- By default, only the ${maxOutputLines} of output are kept`) + '; for long tasks set `timeout` in milliseconds, `0` means no timeout.',
        '',
        '## Enabled but currently unavailable shells',
        '',
        unavailableText,
        '',
        getPowerShellGuidanceDescription(lang),
        '',
        getCmdGuidanceDescription(lang),
        '',
        getPosixShellGuidanceDescription('sh', lang),
        '',
        getPosixShellGuidanceDescription('bash', lang),
        '',
        getGitMsysGuidanceDescription(lang),
        '',
        getWslGuidanceDescription(lang),
        '',
        getZshGuidanceDescription(lang),
        '',
        getPipeGuidanceDescription(lang),
        '',
        getComplexCommandGuidanceDescription(lang),
        '',
        getSshGuidanceDescription(lang)
    ].join('\n');
}

/**
 * 1.2.2-fix：补全 execute_command 的 cwd 选择规则。
 *
 * 为什么要改：模型只看到"relative to workspace root"时，容易把 `cwd`、`command` 内路径、workspace 内外绝对路径混在一起。
 * 怎么改：在主工具描述中集中解释 `cwd` 的职责、单根/多根工作区格式，以及 workspace 内外路径边界。
 * 目的：让模型稳定选择工作目录，减少把 workspace 根目录拼成绝对路径或在多根工作区误用默认根目录的情况。
 */
function getCwdGuidanceDescription(
    workspaceRoots: WorkspaceRootPromptInfo[],
    isMultiRoot: boolean,
    lang: LocalizationLanguage
): string {
    const baseRules = lang === 'zh-CN'
        ? [
            '## cwd 工作目录规则',
            '',
            '- `cwd` 是 Shell 的启动工作目录，不是要操作的文件或目录参数；真正的操作目标仍应写在 `command` 里。',
            '- `cwd` 主要用于 workspace 内目录；当操作目标在 workspace 根目录之内时，`cwd` 和 `command` 里的路径都应使用相对路径。',
            '- 不要把 workspace 根目录拼成绝对路径，例如不要把 `backend` 写成 `C:\\...\\workspace\\backend`。',
            '- 文件就在 workspace 根目录时，`cwd` 不填或填 `.`，并在 `command` 中直接写文件名，例如 `Get-Content package.json`。',
            '- 子目录操作时，`cwd` 写相对目录，例如 `backend`、`frontend/src`，命令内再写相对于该 `cwd` 的路径。',
            '- 只有操作目标位于 workspace 之外时，才在 `command` 中使用绝对路径，例如系统临时目录、下载目录或其他盘符；`cwd` 仍优先保持在 workspace 内。'
        ]
        : [
            '## cwd working directory rules',
            '',
            '- `cwd` is the shell\'s starting working directory, not the file/directory argument to operate on; the real operation target should still be written in `command`.',
            '- `cwd` is mainly for directories inside the workspace; when the operation target is inside the workspace root, use relative paths for both `cwd` and the paths in `command`.',
            '- Do not build absolute paths by concatenating the workspace root, e.g. do not write `backend` as `C:\\...\\workspace\\backend`.',
            '- When the file is in the workspace root, leave `cwd` empty or use `.`, and write the file name directly in `command`, e.g. `Get-Content package.json`.',
            '- For subdirectory operations, write a relative directory in `cwd`, e.g. `backend`, `frontend/src`, and use paths relative to that `cwd` inside the command.',
            '- Only when the operation target is outside the workspace should you use absolute paths in `command`, e.g. system temp directories, download directories, or other drives; keep `cwd` inside the workspace whenever possible.'
        ];

    if (workspaceRoots.length === 0) {
        return [
            ...baseRules,
            lang === 'zh-CN'
                ? '- 当前没有打开 workspace，工具执行时会报错；打开 workspace 后再按上述规则填写 `cwd`。'
                : '- No workspace is currently open; the tool will error when executed. Open a workspace and then fill `cwd` per the rules above.'
        ].join('\n');
    }

    if (isMultiRoot) {
        return [
            ...baseRules,
            lang === 'zh-CN'
                ? '- 多根工作区不要依赖省略 `cwd` 的默认首个工作区；必须显式写 `workspace_name/path` 或 `@workspace_name/path`。'
                : '- In a multi-root workspace, do not rely on omitting `cwd` to default to the first workspace; you must explicitly write `workspace_name/path` or `@workspace_name/path`.',
            lang === 'zh-CN'
                ? '- 多根工作区的根目录写 `workspace_name` 或 `@workspace_name`；子目录写 `workspace_name/backend`、`@workspace_name/frontend/src`。'
                : '- In a multi-root workspace, write the root as `workspace_name` or `@workspace_name`; subdirectories as `workspace_name/backend`, `@workspace_name/frontend/src`.',
            lang === 'zh-CN'
                ? `- 当前可用工作区：${workspaceRoots.map(w => w.name).join(', ')}。`
                : `- Current available workspaces: ${workspaceRoots.map(w => w.name).join(', ')}.`
        ].join('\n');
    }

    return [
        ...baseRules,
        lang === 'zh-CN'
            ? '- 单根工作区中，不传 `cwd` 或传 `.` 表示当前 workspace 根目录。'
            : '- In a single-root workspace, omitting `cwd` or passing `.` means the current workspace root.'
    ].join('\n');
}

/**
 * 1.2.2-fix：把同一套 cwd 规则压缩到参数 schema 描述里。
 *
 * 为什么要改：不同模型有时只读参数描述，不一定完整读完主工具描述。
 * 怎么改：让 `cwd` 字段本身也说明根目录、相对路径、多根工作区和外部路径边界。
 * 目的：在 Function Calling 参数层直接降低 `cwd` 填错概率。
 */
export function getCwdParameterDescription(workspaceRoots: WorkspaceRootPromptInfo[], isMultiRoot: boolean): string {
    const lang = getDeclarationLanguage();
    const common = lang === 'zh-CN'
        ? '`cwd` 是 Shell 启动工作目录，不是目标文件路径；workspace 内使用相对路径，不要拼接 workspace 绝对路径。'
        : '`cwd` is the shell startup working directory, not the target file path; use relative paths inside the workspace and do not concatenate workspace absolute paths.';

    if (workspaceRoots.length === 0) {
        return lang === 'zh-CN'
            ? `${common} 当前没有打开 workspace，工具执行时会报错。`
            : `${common} No workspace is currently open; the tool will error when executed.`;
    }

    if (isMultiRoot) {
        return lang === 'zh-CN'
            ? `${common} 多根工作区必须使用 "workspace_name/path" 或 "@workspace_name/path"；根目录写 workspace_name 或 @workspace_name。可用工作区：${workspaceRoots.map(w => w.name).join(', ')}`
            : `${common} In a multi-root workspace you must use "workspace_name/path" or "@workspace_name/path"; the root is written as workspace_name or @workspace_name. Available workspaces: ${workspaceRoots.map(w => w.name).join(', ')}`;
    }

    return lang === 'zh-CN'
        ? `${common} 单根工作区不传或填 "." 表示 workspace 根目录；子目录写 "backend"、"frontend/src"；workspace 外目标使用 command 内的绝对路径。`
        : `${common} In a single-root workspace, omit \`cwd\` or pass "." for the workspace root; subdirectories as "backend", "frontend/src"; targets outside the workspace use absolute paths in the command.`;
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
            '- 调 native exe 时，PowerShell 解析后还会进入 Windows/native argv 规则；引号和反斜杠紧贴双引号时要格外小心。',
            '- 复杂 Node/Python/JSON/正则内容不要硬写成 `node -e "..."`，优先用单引号 here-string 写临时脚本。'
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
            '- 不要给整条命令外层再加引号（cmd 启动时会剥除最外层引号，命令内再含引号会解析失败）。'
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

function getPosixShellGuidanceDescription(shellName: 'sh' | 'bash', lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            `## ${shellName} 规则（\`shell: "${shellName}"\`）`,
            '',
            `- 使用 POSIX/${shellName} 风格语法，不要使用 PowerShell 的 \`$env:NAME\` 或 CMD 的 \`%NAME%\`。`,
            '- 单引号保留字面量：`\'a|b\'`、`\'$HOME\'`、`\'$(hostname)\'`。',
            '- 双引号允许变量展开和命令替换：`"$HOME"`、`"$(hostname)"`。',
            '- 未引用的 `|` 是管道，示例：`find . -name \'*.ts\' | head`。',
            '- 复杂多行内容优先使用强字面量 heredoc：`cat > /tmp/probe.sh <<\'EOF\' ... EOF`。',
            '- 如果这是 Windows 上的 Git sh/Git Bash，还要遵守 Git/MSYS 路径转换规则。'
        ].join('\n')
        : [
            `## ${shellName} rules (\`shell: "${shellName}"\`)`,
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
            '- WSL 模式通过 `wsl.exe -- bash -c <command>` 执行，命令进入 WSL 内的 bash 解析。',
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

function getZshGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## Zsh 规则（`shell: "zsh"`）',
            '',
            '- Zsh 是类 POSIX shell，常见管道、重定向、单引号、双引号、heredoc 规则接近 sh/bash。',
            '- 单引号保留字面量；双引号允许参数展开和命令替换。',
            '- Zsh 有自己的 glob、alias、扩展规则；不要假定所有 Bash 专有行为完全一致。',
            '- 复杂多行内容仍优先写临时脚本再执行。'
        ].join('\n')
        : [
            '## Zsh rules (`shell: "zsh"`)',
            '',
            '- Zsh is a POSIX-like shell; common pipe, redirection, single-quote, double-quote, and heredoc rules are close to sh/bash.',
            '- Single quotes preserve literals; double quotes allow parameter expansion and command substitution.',
            '- Zsh has its own glob, alias, and expansion rules; do not assume all Bash-specific behavior is identical.',
            '- For complex multi-line content, still prefer writing a temp script first.'
        ].join('\n');
}

function getPipeGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## 管道符 `|` 规则',
            '',
            '- `|` 是否是管道，取决于当前 shell 是否在未引用状态下看到它。',
            '- 作为管道：PowerShell `Get-ChildItem | Select-Object -First 10`；CMD `dir | findstr foo`；sh/bash/zsh `find . -name \'*.ts\' | head`。',
            '- 作为普通字符：PowerShell `\'a|b\'`；CMD `"a|b"` 或必要时 `a^|b`；sh/bash/zsh `\'a|b\'`。',
            '- 不要把一个 shell 的转义规则套到另一个 shell：PowerShell 不使用 CMD 的 `^|`；CMD 不依赖 Bash 单引号；sh/bash 不使用 `$env:NAME`。'
        ].join('\n')
        : [
            '## Pipe `|` rules',
            '',
            '- Whether `|` is a pipe depends on whether the current shell sees it unquoted.',
            '- As a pipe: PowerShell `Get-ChildItem | Select-Object -First 10`; CMD `dir | findstr foo`; sh/bash/zsh `find . -name \'*.ts\' | head`.',
            '- As a plain character: PowerShell `\'a|b\'`; CMD `"a|b"` or, when needed, `a^|b`; sh/bash/zsh `\'a|b\'`.',
            '- Do not apply one shell\'s escaping rules to another: PowerShell does not use CMD\'s `^|`; CMD does not rely on Bash single quotes; sh/bash do not use `$env:NAME`.'
        ].join('\n');
}

function getComplexCommandGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## 复杂命令规则',
            '',
            '- 简单命令可以直接内联；包含多层引号、JSON、正则、Node/Python 代码、Nginx/systemd 配置、SSH 远端脚本时，不要强行写成一行。',
            '- PowerShell 推荐：用 `@\' ... \'@` 单引号 here-string 写入临时脚本，再用 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` 保存为 UTF-8 无 BOM 后执行。',
            '- sh/bash/zsh 推荐：用 `cat > /tmp/script.sh <<\'EOF\' ... EOF` 写强字面量 heredoc，再执行脚本。',
            '- CMD 不适合承载复杂多行脚本；除非用户明确要求 CMD，否则复杂逻辑优先用 PowerShell 或 sh。',
            '- 诊断引号/管道问题时，先写一个 argv/hex 探针确认目标程序实际收到什么，不要猜。'
        ].join('\n')
        : [
            '## Complex command rules',
            '',
            '- Simple commands can be inlined; do not force content with nested quotes, JSON, regex, Node/Python code, Nginx/systemd config, or SSH remote scripts into a single line.',
            '- PowerShell: prefer writing a temp script with an `@\' ... \'@` single-quoted here-string, then save it as UTF-8 without BOM via `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` and run it.',
            '- sh/bash/zsh: prefer writing a strong-literal heredoc `cat > /tmp/script.sh <<\'EOF\' ... EOF`, then run the script.',
            '- CMD is not suited for complex multi-line scripts; unless the user explicitly asks for CMD, prefer PowerShell or sh for complex logic.',
            '- When diagnosing quote/pipe issues, first write an argv/hex probe to confirm what the target program actually receives; do not guess.'
        ].join('\n');
}

function getSshGuidanceDescription(lang: LocalizationLanguage): string {
    return lang === 'zh-CN'
        ? [
            '## SSH 多层解析规则',
            '',
            '- SSH 至少有两层解析：本地 shell 先解析整条 `ssh ...` 命令；远端用户 shell 再解析远端命令。远端命令不是 argv 直达目标程序。',
            '- 在 PowerShell 中调用 SSH，外层单引号只能阻止本地 PowerShell 展开；远端 shell 仍会解释 `$HOME`、`$(hostname)`、`|` 等。',
            '- 当前实测链路 PowerShell → ssh → 远端 bash 中，如果需要远端 shell 用双引号保护参数，PowerShell 命令里通常要写 `\\"`；如果要远端收到字面 `$HOME`，写 `\\"\\$HOME\\"`；字面 `$(hostname)` 写 `\\"\\$(hostname)\\"`。',
            '- 复杂远端操作不要硬塞一行：优先本地生成脚本，`scp` 上传到远端 `/tmp/...`，`ssh` 执行远端脚本，完成后清理脚本。',
            '- Windows 用户目录 SSH key 示例：`ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" root@host \'hostname\'`。'
        ].join('\n')
        : [
            '## SSH multi-layer parsing rules',
            '',
            '- SSH has at least two parsing layers: the local shell first parses the whole `ssh ...` command; the remote user shell then parses the remote command. The remote command is not passed as argv directly to the target program.',
            '- When calling SSH from PowerShell, an outer single quote only stops local PowerShell expansion; the remote shell still interprets `$HOME`, `$(hostname)`, `|`, etc.',
            '- In the currently tested PowerShell → ssh → remote bash chain, if the remote shell needs double quotes to protect arguments, PowerShell commands usually need `\\"`; to deliver a literal `$HOME` remotely, write `\\"\\$HOME\\"`; literal `$(hostname)` write `\\"\\$(hostname)\\"`.',
            '- Do not cram complex remote operations into one line: prefer generating the script locally, `scp` it to `/tmp/...` on the remote, `ssh` to run it, then clean up the script.',
            '- Windows SSH key example in the user directory: `ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" root@host \'hostname\'`.'
        ].join('\n');
}
