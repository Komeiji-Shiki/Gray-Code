/**
 * MCP 服务器管理消息处理器
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';
import type { MessageHandler } from '../types';
import { withBoundary } from './errorBoundary';

// 04#6：payload 形状校验已收敛到 MessageRouter.route() 入口（见 shared/protocol.ts 的
// MESSAGE_SCHEMAS）。此处不再手写「data 必须是对象」的守卫，handler 只做业务处理；
// 非法 payload 会在入口处回 INVALID_DATA。

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'FileNotFound' || code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 打开 MCP 配置文件
 */
export const openMcpConfigFile: MessageHandler = async (data, requestId, ctx) => {
  const mcpConfigDir = ctx.storagePathManager.getMcpPath();
  const mcpConfigFile = path.join(mcpConfigDir, 'servers.json');
  
  // 确保目录存在
  const configDirUri = vscode.Uri.file(mcpConfigDir);
  if (!await pathExists(configDirUri)) {
    await vscode.workspace.fs.createDirectory(configDirUri);
  }
  
  // 确保配置文件存在
  const configUri = vscode.Uri.file(mcpConfigFile);
  if (!await pathExists(configUri)) {
    const defaultConfig = { mcpServers: {} };
    await vscode.workspace.fs.writeFile(
      configUri,
      Buffer.from(JSON.stringify(defaultConfig, null, 2), 'utf-8')
    );
  }
  
  // 在 VSCode 编辑器中打开配置文件
  const document = await vscode.workspace.openTextDocument(configUri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 获取 MCP 服务器列表
 */
export const getMcpServers: MessageHandler = async (data, requestId, ctx) => {
  const servers = await ctx.mcpManager.listServers();
  ctx.sendResponse(requestId, { success: true, servers });
};

/**
 * 验证 MCP 服务器 ID
 */
export const validateMcpServerId: MessageHandler = async (data, requestId, ctx) => {
  const { id, excludeId } = data ?? {};
  const result = await ctx.mcpManager.validateServerId(id, excludeId);
  ctx.sendResponse(requestId, { success: true, ...result });
};

/**
 * 创建 MCP 服务器
 */
export const createMcpServer: MessageHandler = async (data, requestId, ctx) => {
  const { input, customId } = data ?? {};
  const serverId = await ctx.mcpManager.createServer(input, customId);
  ctx.sendResponse(requestId, { success: true, serverId });
};

/**
 * 更新 MCP 服务器
 */
export const updateMcpServer: MessageHandler = async (data, requestId, ctx) => {
  const { serverId, updates } = data ?? {};
  await ctx.mcpManager.updateServer(serverId, updates);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 删除 MCP 服务器
 */
export const deleteMcpServer: MessageHandler = async (data, requestId, ctx) => {
  const { serverId } = data ?? {};
  await ctx.mcpManager.deleteServer(serverId);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 连接 MCP 服务器
 */
export const connectMcpServer: MessageHandler = async (data, requestId, ctx) => {
  const { serverId } = data ?? {};
  await ctx.mcpManager.connect(serverId);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 断开 MCP 服务器
 */
export const disconnectMcpServer: MessageHandler = async (data, requestId, ctx) => {
  const { serverId } = data ?? {};
  await ctx.mcpManager.disconnect(serverId);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 设置 MCP 服务器启用状态
 */
export const setMcpServerEnabled: MessageHandler = async (data, requestId, ctx) => {
  const { serverId, enabled } = data ?? {};
  await ctx.mcpManager.setServerEnabled(serverId, enabled);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 注册 MCP 处理器
 */
export function registerMcpHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES.openMcpConfigFile, withBoundary('OPEN_MCP_CONFIG_ERROR', t('webview.errors.openMcpConfigFailed'), openMcpConfigFile));
  registry.set(MESSAGE_NAMES.getMcpServers, withBoundary('GET_MCP_SERVERS_ERROR', t('webview.errors.getMcpServersFailed'), getMcpServers));
  registry.set(MESSAGE_NAMES.validateMcpServerId, withBoundary('VALIDATE_MCP_SERVER_ID_ERROR', t('webview.errors.validateMcpServerIdFailed'), validateMcpServerId));
  registry.set(MESSAGE_NAMES.createMcpServer, withBoundary('CREATE_MCP_SERVER_ERROR', t('webview.errors.createMcpServerFailed'), createMcpServer));
  registry.set(MESSAGE_NAMES.updateMcpServer, withBoundary('UPDATE_MCP_SERVER_ERROR', t('webview.errors.updateMcpServerFailed'), updateMcpServer));
  registry.set(MESSAGE_NAMES.deleteMcpServer, withBoundary('DELETE_MCP_SERVER_ERROR', t('webview.errors.deleteMcpServerFailed'), deleteMcpServer));
  registry.set(MESSAGE_NAMES.connectMcpServer, withBoundary('CONNECT_MCP_SERVER_ERROR', t('webview.errors.connectMcpServerFailed'), connectMcpServer));
  registry.set(MESSAGE_NAMES.disconnectMcpServer, withBoundary('DISCONNECT_MCP_SERVER_ERROR', t('webview.errors.disconnectMcpServerFailed'), disconnectMcpServer));
  registry.set(MESSAGE_NAMES.setMcpServerEnabled, withBoundary('SET_MCP_SERVER_ENABLED_ERROR', t('webview.errors.setMcpServerEnabledFailed'), setMcpServerEnabled));
}
