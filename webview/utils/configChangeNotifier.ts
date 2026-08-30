/**
 * 配置变更刷新通知（渠道 / MCP / 设置导入）。
 *
 * 为什么需要它：webview 侧的配置视图都是「按需拉取 + 模块级缓存」——输入区渠道下拉、
 * MCP 服务器列表、设置页渠道列表各自在挂载时拉一次数据，后端数据变更后前端不会自动重拉。
 * 设置页内的单次编辑由前端在发请求后自己 await 刷新，但「一次请求改了多条配置」的外部
 * 批量变更（设置导入）没有这个自发刷新时机，只能由后端推送通知；否则用户必须重启插件
 * （重置模块缓存 + 重新预加载）才能看到刚导入的配置。
 *
 * payload 约定（监听方据此区分是否要重拉）：
 * - 带 configId：设置页内针对单个配置的一次编辑，该视图已经自行刷新过，监听方可忽略；
 * - 不带 configId（空对象）：外部批量变更（导入等），监听方应重新拉取全量数据。
 */
import { PUSH_MESSAGE_NAMES } from '../../shared/protocol';
import type { HandlerContext } from '../types';

/**
 * 向 webview 投递一条 type:'command' 推送。
 * 路由上下文优先走 ctx.postMessage；非路由上下文（测试/直连）回退 ctx.view 直投。
 */
function postConfigCommand(
    ctx: HandlerContext,
    command: (typeof PUSH_MESSAGE_NAMES)[keyof typeof PUSH_MESSAGE_NAMES],
    data: Record<string, unknown>
): void {
    const message = {
        type: PUSH_MESSAGE_NAMES.command,
        command,
        data
    };
    if (ctx.postMessage) {
        ctx.postMessage(message);
        return;
    }
    ctx.view?.webview.postMessage(message);
}

/**
 * 通知渠道/模型配置已变更（输入区渠道下拉、任务卡渠道下拉、设置页渠道列表据此刷新）。
 *
 * @param configId 变更的单个配置 ID；省略表示外部批量变更（导入等），
 *                 需要重拉全量列表的视图只处理这种省略形式
 */
export function notifyChannelsChanged(ctx: HandlerContext, configId?: string): void {
    postConfigCommand(
        ctx,
        PUSH_MESSAGE_NAMES['channels.configChanged'],
        configId ? { configId } : {}
    );
}

/** 通知 MCP 服务器配置已变更（MCP 设置页服务器列表据此刷新）。 */
export function notifyMcpServersChanged(ctx: HandlerContext): void {
    postConfigCommand(ctx, PUSH_MESSAGE_NAMES['mcp.configChanged'], {});
}

/** 通知 VSCode 设置项已被批量替换（设置面板据此重新拉取表单值）。 */
export function notifyVscodeSettingsReplaced(ctx: HandlerContext): void {
    postConfigCommand(ctx, PUSH_MESSAGE_NAMES['settings.imported'], {});
}

/**
 * 设置导入完成后按域广播刷新通知。
 *
 * 只对实际发生变更的域广播：渠道重拉的成本是 listConfigs + N×getConfig，
 * 无变更也广播会让每次导入都白跑一轮全量请求。
 * 导入 0 条即「跳过已存在项」模式下文件里的配置本地全有，界面本来就正确。
 *
 * Skills 域刻意不广播：SkillsManager.refresh() 已在导入内部执行（后端数据与工具声明
 * 即时生效），而前端 SkillsWidget 在每次展开面板时都会 listSkills 重新拉取，
 * 不存在需要重启才能看到的陈旧视图。
 */
export function notifyImportedScopesChanged(
    ctx: HandlerContext,
    imported: {
        vscodeSettings: boolean;
        channelConfigs: number;
        mcpServers: number;
        skills: number;
    }
): void {
    if (imported.channelConfigs > 0) {
        notifyChannelsChanged(ctx);
    }
    if (imported.mcpServers > 0) {
        notifyMcpServersChanged(ctx);
    }
    if (imported.vscodeSettings) {
        notifyVscodeSettingsReplaced(ctx);
    }
}
