/**
 * execute_command tool description & prompt generation
 *
 * Split from execute_command.ts: dynamic tool description (OS/workspace
 * info), shell usage guidance prompts, cwd rules, and per-shell parsing
 * rule descriptions.
 */

import * as os from 'os';
import * as vscode from 'vscode';
import { getDefaultShellName, getDefaultShellType, getUnavailableShellsDescription } from './shellConfig';
import { getMaxOutputLines } from './outputDecoder';

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

/**
 * execute_command 的中文 Shell 使用提示词。
 *
 * 设计原则：保持 execute_command 作为 pure shell 工具，不新增 argv/script/stdin 模式；
 * 通过明确每种 shell 的解析规则降低模型误用概率。
 */
export function getExecuteCommandShellGuidanceDescription(
    workspaceRoots: WorkspaceRootPromptInfo[],
    isMultiRoot: boolean
): string {
    const defaultShellType = getDefaultShellType();
    const maxOutputLines = getMaxOutputLines() === -1 ? '全部' : `最后 ${getMaxOutputLines()}`;

    return [
        '## 重要语义',
        '',
        '`command` 是一段 Shell 文本，不是 argv 数组。Function Calling 只负责把字符串交给工具；随后该字符串会被 `shell` 参数指定的 Shell 继续解析。你必须按照所选 Shell 的语法书写命令。',
        '',
        getCwdGuidanceDescription(workspaceRoots, isMultiRoot),
        '',
        '## Shell 选择规则',
        '',
        `- 如果不传 \`shell\` 或设置为 \`default\`，将使用当前默认 Shell：\`${defaultShellType}\`（${getDefaultShellName()}）。`,
        '- 当前只能选择 "Enabled Shells" 列表和参数 enum 中出现的 shell；不要选择不可用的 shell。',
        '- Windows 文件系统、PowerShell cmdlet、对象管道：优先选择 `powershell`。',
        '- CMD 内置命令、批处理兼容行为：选择 `cmd`。',
        '- POSIX sh 语法、`grep` / `sed` / `find` / `head`、heredoc：选择 `sh` / `bash` / `gitbash`。',
        '- macOS 默认通常是 `zsh`；Linux 默认通常是 `bash`。',
        '- 返回输出默认只保留' + maxOutputLines + '行；长任务请设置 `timeout`，单位毫秒，`0` 表示不超时。',
        '',
        '## 当前已配置但不可用的 Shell',
        '',
        getUnavailableShellsDescription(),
        '',
        getPowerShellGuidanceDescription(),
        '',
        getCmdGuidanceDescription(),
        '',
        getPosixShellGuidanceDescription('sh'),
        '',
        getPosixShellGuidanceDescription('bash'),
        '',
        getGitMsysGuidanceDescription(),
        '',
        getWslGuidanceDescription(),
        '',
        getZshGuidanceDescription(),
        '',
        getPipeGuidanceDescription(),
        '',
        getComplexCommandGuidanceDescription(),
        '',
        getSshGuidanceDescription()
    ].join('\n');
}

/**
 * 1.2.2-fix：补全 execute_command 的 cwd 选择规则。
 *
 * 为什么要改：模型只看到"relative to workspace root"时，容易把 `cwd`、`command` 内路径、workspace 内外绝对路径混在一起。
 * 怎么改：在主工具描述中集中解释 `cwd` 的职责、单根/多根工作区格式，以及 workspace 内外路径边界。
 * 目的：让模型稳定选择工作目录，减少把 workspace 根目录拼成绝对路径或在多根工作区误用默认根目录的情况。
 */
function getCwdGuidanceDescription(workspaceRoots: WorkspaceRootPromptInfo[], isMultiRoot: boolean): string {
    const baseRules = [
        '## cwd 工作目录规则',
        '',
        '- `cwd` 是 Shell 的启动工作目录，不是要操作的文件或目录参数；真正的操作目标仍应写在 `command` 里。',
        '- `cwd` 主要用于 workspace 内目录；当操作目标在 workspace 根目录之内时，`cwd` 和 `command` 里的路径都应使用相对路径。',
        '- 不要把 workspace 根目录拼成绝对路径，例如不要把 `backend` 写成 `C:\\...\\workspace\\backend`。',
        '- 文件就在 workspace 根目录时，`cwd` 不填或填 `.`，并在 `command` 中直接写文件名，例如 `Get-Content package.json`。',
        '- 子目录操作时，`cwd` 写相对目录，例如 `backend`、`frontend/src`，命令内再写相对于该 `cwd` 的路径。',
        '- 只有操作目标位于 workspace 之外时，才在 `command` 中使用绝对路径，例如系统临时目录、下载目录或其他盘符；`cwd` 仍优先保持在 workspace 内。'
    ];

    if (workspaceRoots.length === 0) {
        return [
            ...baseRules,
            '- 当前没有打开 workspace，工具执行时会报错；打开 workspace 后再按上述规则填写 `cwd`。'
        ].join('\n');
    }

    if (isMultiRoot) {
        return [
            ...baseRules,
            '- 多根工作区不要依赖省略 `cwd` 的默认首个工作区；必须显式写 `workspace_name/path` 或 `@workspace_name/path`。',
            '- 多根工作区的根目录写 `workspace_name` 或 `@workspace_name`；子目录写 `workspace_name/backend`、`@workspace_name/frontend/src`。',
            `- 当前可用工作区：${workspaceRoots.map(w => w.name).join(', ')}。`
        ].join('\n');
    }

    return [
        ...baseRules,
        '- 单根工作区中，不传 `cwd` 或传 `.` 表示当前 workspace 根目录。'
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
    const common = '`cwd` 是 Shell 启动工作目录，不是目标文件路径；workspace 内使用相对路径，不要拼接 workspace 绝对路径。';

    if (workspaceRoots.length === 0) {
        return `${common} 当前没有打开 workspace，工具执行时会报错。`;
    }

    if (isMultiRoot) {
        return `${common} 多根工作区必须使用 "workspace_name/path" 或 "@workspace_name/path"；根目录写 workspace_name 或 @workspace_name。Available workspaces: ${workspaceRoots.map(w => w.name).join(', ')}`;
    }

    return `${common} 单根工作区不传或填 "." 表示 workspace 根目录；子目录写 "backend"、"frontend/src"；workspace 外目标使用 command 内的绝对路径。`;
}

function getPowerShellGuidanceDescription(): string {
    return [
        '## PowerShell 规则（`shell: "powershell"`）',
        '',
        '- PowerShell 不是 Bash；不要把 Bash 语法直接写进 PowerShell。',
        '- 单引号保留字面量：`\'a|b\'`、`\'$HOME\'`、`\'$(hostname)\'`。',
        '- 双引号会展开 PowerShell 变量和子表达式：`"$env:TEMP"`、`"$(Get-Date)"`。',
        '- 环境变量写法是 `$env:NAME`，例如 `$env:TEMP`，不是 Bash 的 `$NAME`。',
        '- 未引用的 `|` 是 PowerShell 管道，示例：`Get-ChildItem | Select-Object -First 10`。',
        '- 调用路径含空格的可执行文件，用 `&`：`& "C:\\Program Files\\nodejs\\node.exe" --version`。',
        '- 调 native exe 时，PowerShell 解析后还会进入 Windows/native argv 规则；引号和反斜杠紧贴双引号时要格外小心。',
        '- 复杂 Node/Python/JSON/正则内容不要硬写成 `node -e "..."`，优先用 single-quoted here-string 写临时脚本。'
    ].join('\n');
}

function getCmdGuidanceDescription(): string {
    return [
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
    ].join('\n');
}

function getPosixShellGuidanceDescription(shellName: 'sh' | 'bash'): string {
    return [
        `## ${shellName} 规则（\`shell: "${shellName}"\`）`,
        '',
        `- 使用 POSIX/${shellName} 风格语法，不要使用 PowerShell 的 \`$env:NAME\` 或 CMD 的 \`%NAME%\`。`,
        '- 单引号保留字面量：`\'a|b\'`、`\'$HOME\'`、`\'$(hostname)\'`。',
        '- 双引号允许变量展开和命令替换：`"$HOME"`、`"$(hostname)"`。',
        '- 未引用的 `|` 是管道，示例：`find . -name \'*.ts\' | head`。',
        '- 复杂多行内容优先使用强字面量 heredoc：`cat > /tmp/probe.sh <<\'EOF\' ... EOF`。',
        '- 如果这是 Windows 上的 Git sh/Git Bash，还要遵守 Git/MSYS 路径转换规则。'
    ].join('\n');
}

function getGitMsysGuidanceDescription(): string {
    return [
        '## Git Bash / Git sh / MSYS 额外规则',
        '',
        '- Git Bash/Git sh 使用类 sh/bash 语法，但运行在 Windows/MSYS 环境中，不等于真实 Linux。',
        '- 传给 Windows 原生程序的以 `/` 开头参数可能被自动转换为 Windows 路径，例如 `/a/b/c` 可能变成 `A:/b/c`。',
        '- 正则 `/xxx/`、Linux 远端路径、Docker volume、`-L/regex/` 等要小心路径转换污染。',
        '- 必要时可在命令前设置 `MSYS_NO_PATHCONV=1`，或使用 `MSYS2_ARG_CONV_EXCL=*`。'
    ].join('\n');
}

function getWslGuidanceDescription(): string {
    return [
        '## WSL 规则（`shell: "wsl"`）',
        '',
        '- WSL 模式通过 `wsl.exe -- bash -c <command>` 执行，命令进入 WSL 内的 bash 解析。',
        '- 路径应使用 WSL/Linux 格式，例如 `/mnt/c/Users/...`，不要直接使用 PowerShell 的 `$env:TEMP`。',
        '- 从 WSL 调 Windows 程序通常需要写 `.exe`，例如 `notepad.exe`。',
        '- 如果当前环境提示 WSL 未安装或未启用，不要选择 `wsl`。'
    ].join('\n');
}

function getZshGuidanceDescription(): string {
    return [
        '## Zsh 规则（`shell: "zsh"`）',
        '',
        '- Zsh 是类 POSIX shell，常见管道、重定向、单引号、双引号、heredoc 规则接近 sh/bash。',
        '- 单引号保留字面量；双引号允许参数展开和命令替换。',
        '- Zsh 有自己的 glob、alias、扩展规则；不要假定所有 Bash 专有行为完全一致。',
        '- 复杂多行内容仍优先写临时脚本再执行。'
    ].join('\n');
}

function getPipeGuidanceDescription(): string {
    return [
        '## 管道符 `|` 规则',
        '',
        '- `|` 是否是管道，取决于当前 shell 是否在未引用状态下看到它。',
        '- 作为管道：PowerShell `Get-ChildItem | Select-Object -First 10`；CMD `dir | findstr foo`；sh/bash/zsh `find . -name \'*.ts\' | head`。',
        '- 作为普通字符：PowerShell `\'a|b\'`；CMD `"a|b"` 或必要时 `a^|b`；sh/bash/zsh `\'a|b\'`。',
        '- 不要把一个 shell 的转义规则套到另一个 shell：PowerShell 不使用 CMD 的 `^|`；CMD 不依赖 Bash 单引号；sh/bash 不使用 `$env:NAME`。'
    ].join('\n');
}

function getComplexCommandGuidanceDescription(): string {
    return [
        '## 复杂命令规则',
        '',
        '- 简单命令可以直接内联；包含多层引号、JSON、正则、Node/Python 代码、Nginx/systemd 配置、SSH 远端脚本时，不要强行写成一行。',
        '- PowerShell 推荐：用 `@\' ... \'@` single-quoted here-string 写入临时脚本，再用 `[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))` 保存为 UTF-8 无 BOM 后执行。',
        '- sh/bash/zsh 推荐：用 `cat > /tmp/script.sh <<\'EOF\' ... EOF` 写强字面量 heredoc，再执行脚本。',
        '- CMD 不适合承载复杂多行脚本；除非用户明确要求 CMD，否则复杂逻辑优先用 PowerShell 或 sh。',
        '- 诊断引号/管道问题时，先写一个 argv/hex 探针确认目标程序实际收到什么，不要猜。'
    ].join('\n');
}

function getSshGuidanceDescription(): string {
    return [
        '## SSH 多层解析规则',
        '',
        '- SSH 至少有两层解析：本地 shell 先解析整条 `ssh ...` 命令；远端用户 shell 再解析远端命令。远端命令不是 argv 直达目标程序。',
        '- 在 PowerShell 中调用 SSH，外层单引号只能阻止本地 PowerShell 展开；远端 shell 仍会解释 `$HOME`、`$(hostname)`、`|` 等。',
        '- 当前实测链路 PowerShell → ssh → 远端 bash 中，如果需要远端 shell 用双引号保护参数，PowerShell 命令里通常要写 `\\"`；如果要远端收到字面 `$HOME`，写 `\\"\\$HOME\\"`；字面 `$(hostname)` 写 `\\"\\$(hostname)\\"`。',
        '- 复杂远端操作不要硬塞一行：优先本地生成脚本，`scp` 上传到远端 `/tmp/...`，`ssh` 执行远端脚本，完成后清理脚本。',
        '- Windows 用户目录 SSH key 示例：`ssh -i "$env:USERPROFILE\\.ssh\\id_ed25519" root@host \'hostname\'`。'
    ].join('\n');
}