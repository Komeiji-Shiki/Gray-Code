import * as os from 'os';
import type { Tool } from '../types';
import { getActualLanguage } from '../../i18n';
import { resolveLocalizationLanguage } from '../localization/types';
import type { createTerminalRuntimeHost } from './runtimeTypes';

export function createExecuteCommandDeclaration(host: createTerminalRuntimeHost): Tool['declaration'] {
    const { getEnabledShellTypesForEnum } = host.shells;
    const { getAllWorkspaceRoots, getOSName, getCwdParameterDescription, getExecuteCommandShellGuidanceDescription } = host.prompts;
    const osName = getOSName();
    const osArch = os.arch();
    const osRelease = os.release();
    // 模型声明语言：zh-CN → 中文，en/ja → 英文（ja 本阶段映射到英文说明）
    const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';

    // 获取工作区信息
    const workspaceRoots = getAllWorkspaceRoots();
    const isMultiRoot = workspaceRoots.length > 1;

    // 生成工作区说明
    let workspaceDescription = '';
    if (isMultiRoot) {
        // cwd 的多根写法由 cwd 参数说明负责，这里只列出各工作区的实际路径。
        workspaceDescription = isZh
            ? '\n\n工作区（多根，cwd 的写法见参数说明）：\n' + workspaceRoots.map((ws) => `- ${ws.name}: ${ws.path}`).join('\n')
            : '\n\nWorkspaces (multi-root; see the cwd parameter for how to write cwd):\n' +
              workspaceRoots.map((ws) => `- ${ws.name}: ${ws.path}`).join('\n');
    }

    // 1.2.2-fix：cwd 参数描述复用统一规则生成器（promptDescriptions 内部已按语言生成）。
    // 为什么要改：旧描述过短，模型经常不知道应填工作区相对路径还是绝对路径。
    // 怎么改：按单根/多根工作区动态生成 schema 字段说明。
    // 目的：让只读取参数 schema 的模型也能正确选择 cwd。
    const cwdDescription = getCwdParameterDescription(workspaceRoots, isMultiRoot);
    const defaultTimeout = host.getConfig().defaultTimeout;

    return {
        name: 'execute_command',
        category: 'terminal',
        strict: true, // API 端强制 schema 校验
        description: isZh
            ? '执行命令并返回输出。默认交给 Shell 解析；mode=argv 直接启动可执行文件并原样传递 args，不解析管道、重定向或环境变量，' +
              '启动后最多等待 300 毫秒即返回 taskId，进程继续运行。' +
              `操作系统：${osName} (${osArch})，版本 ${osRelease}。${workspaceDescription}\n\n${getExecuteCommandShellGuidanceDescription()}`
            : 'Run a command and return its output. Commands go through a shell by default; mode=argv starts an executable with literal args ' +
              'without parsing pipes, redirection or environment variables, and returns a taskId within 300 ms while the process keeps running. ' +
              `OS: ${osName} (${osArch}), version ${osRelease}.${workspaceDescription}\n\n${getExecuteCommandShellGuidanceDescription()}`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                mode: {
                    type: 'string',
                    enum: ['shell', 'argv'],
                    default: 'shell',
                },
                command: {
                    type: 'string',
                    minLength: 1,
                    description: isZh ? 'Shell 命令文本，或 argv 模式的可执行文件。' : 'Shell command text, or the executable in argv mode.',
                },
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: isZh
                        ? '仅用于 argv：原样传给可执行文件的参数数组，必填；无参数时传空数组。'
                        : 'Required in argv mode: literal executable arguments; use an empty array for none.',
                },
                cwd: {
                    type: 'string',
                    description: cwdDescription,
                },
                shell: {
                    type: 'string',
                    description: isZh ? '仅用于 Shell 模式。' : 'Only used in shell mode.',
                    enum: getEnabledShellTypesForEnum(),
                    default: 'default',
                },
                timeout: {
                    type: 'number',
                    description: isZh
                        ? `命令超时毫秒数。Shell 前台默认 ${defaultTimeout}；argv 默认 0（不限时），显式指定时也会终止已返回 taskId 的进程。background=true 不受此限制。`
                        : `Timeout in milliseconds. Foreground shell defaults to ${defaultTimeout}; argv defaults to 0 (unlimited). ` +
                          'An explicit timeout also stops a returned session. background=true ignores it.',
                    default: defaultTimeout,
                },
                background: {
                    type: 'boolean',
                    description: isZh
                        ? '在后台运行命令。只用于用户不必等待的长时间任务，例如构建、服务器或批处理。' +
                          '工具会立即返回 taskId，最终输出稍后以 "[Background task completed]" 用户消息送达，不要等待或轮询。'
                        : 'Run the command in the background. Use this only for long-running work the user should not have to wait for, ' +
                          'such as builds, servers or batch jobs. The tool returns a taskId right away, and the final output arrives later ' +
                          'as a "[Background task completed]" user message; do not wait or poll for it.',
                },
            },
            required: ['command'],
        },
    };
}
