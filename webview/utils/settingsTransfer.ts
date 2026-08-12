/**
 * 设置导出/导入共享工具（发现 7 部分收敛）。
 *
 * 收敛 SettingsExporter 构造参数（5 个 manager + 版本 + skills 目录）的重复实现：
 * ChatViewProvider.exportSettings/importSettings 与
 * handlers/SettingsTransferHandlers.createExporter 共用 createSettingsExporter。
 *
 * 对话框 / 写文件 / 解析导入流程暂不强制统一：三处入口语义不同（命令入口带进度条、
 * webview handler 直接回响应、默认文件名解析方式略有差异），合并会改变某一侧既有行为。
 */
import * as path from 'path';
import { SettingsExporter } from '../../backend/modules/settings';
import type { SettingsManager, StoragePathManager } from '../../backend/modules/settings';
import type { ConfigManager } from '../../backend/modules/config';
import type { McpManager } from '../../backend/modules/mcp';
import { getSkillsManager } from '../../backend/modules/skills';
import { getExtensionVersion } from './extensionInfo';

export function createSettingsExporter(args: {
    settingsManager: SettingsManager;
    configManager: ConfigManager;
    mcpManager: McpManager;
    storagePathManager: StoragePathManager;
    /** 扩展路径（有 context 的入口提供；缺失时版本回退 '0.0.0'） */
    extensionPath?: string;
}): SettingsExporter | null {
    const skillsManager = getSkillsManager();
    if (!skillsManager) {
        return null;
    }
    return new SettingsExporter(
        args.settingsManager,
        args.configManager,
        args.mcpManager,
        skillsManager,
        args.extensionPath ? getExtensionVersion(args.extensionPath) : '0.0.0',
        path.join(args.storagePathManager.getEffectiveDataPath(), 'skills')
    );
}
