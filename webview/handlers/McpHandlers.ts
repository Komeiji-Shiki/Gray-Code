/**
 * MCP 服务器管理消息处理器
 */

import { MESSAGE_NAMES } from '../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';
import type { MessageHandler } from '../types';

function requireMcpData(data: unknown, requestId: string, ctx: Parameters<MessageHandler>[2]): Record<string, any> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    ctx.sendError(requestId, 'INVALID_PARAMS', 'Invalid MCP request parameters');
    return null;
  }
  return data as Record<string, any>;
}

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
  try {
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
  } catch (error: any) {
    ctx.sendError(requestId, 'OPEN_MCP_CONFIG_ERROR', error.message || t('webview.errors.openMcpConfigFailed'));
  }
};

/**
 * 获取 MCP 服务器列表
 */
export const getMcpServers: MessageHandler = async (data, requestId, ctx) => {
  try {
    const servers = await ctx.mcpManager.listServers();
    ctx.sendResponse(requestId, { success: true, servers });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_MCP_SERVERS_ERROR', error.message || t('webview.errors.getMcpServersFailed'));
  }
};

/**
 * 验证 MCP 服务器 ID
 */
export const validateMcpServerId: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { id, excludeId } = params;
    const result = await ctx.mcpManager.validateServerId(id, excludeId);
    ctx.sendResponse(requestId, { success: true, ...result });
  } catch (error: any) {
    ctx.sendError(requestId, 'VALIDATE_MCP_SERVER_ID_ERROR', error.message || t('webview.errors.validateMcpServerIdFailed'));
  }
};

/**
 * 创建 MCP 服务器
 */
export const createMcpServer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { input, customId } = params;
    const serverId = await ctx.mcpManager.createServer(input, customId);
    ctx.sendResponse(requestId, { success: true, serverId });
  } catch (error: any) {
    ctx.sendError(requestId, 'CREATE_MCP_SERVER_ERROR', error.message || t('webview.errors.createMcpServerFailed'));
  }
};

/**
 * 更新 MCP 服务器
 */
export const updateMcpServer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { serverId, updates } = params;
    await ctx.mcpManager.updateServer(serverId, updates);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'UPDATE_MCP_SERVER_ERROR', error.message || t('webview.errors.updateMcpServerFailed'));
  }
};

/**
 * 删除 MCP 服务器
 */
export const deleteMcpServer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { serverId } = params;
    await ctx.mcpManager.deleteServer(serverId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DELETE_MCP_SERVER_ERROR', error.message || t('webview.errors.deleteMcpServerFailed'));
  }
};

/**
 * 连接 MCP 服务器
 */
export const connectMcpServer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { serverId } = params;
    await ctx.mcpManager.connect(serverId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'CONNECT_MCP_SERVER_ERROR', error.message || t('webview.errors.connectMcpServerFailed'));
  }
};

/**
 * 断开 MCP 服务器
 */
export const disconnectMcpServer: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { serverId } = params;
    await ctx.mcpManager.disconnect(serverId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'DISCONNECT_MCP_SERVER_ERROR', error.message || t('webview.errors.disconnectMcpServerFailed'));
  }
};

/**
 * 设置 MCP 服务器启用状态
 */
export const setMcpServerEnabled: MessageHandler = async (data, requestId, ctx) => {
  try {
    const params = requireMcpData(data, requestId, ctx);
    if (!params) return;
    const { serverId, enabled } = params;
    await ctx.mcpManager.setServerEnabled(serverId, enabled);
    ctx.sendResponse(requestId, { success: true });
  } catch (error: any) {
    ctx.sendError(requestId, 'SET_MCP_SERVER_ENABLED_ERROR', error.message || t('webview.errors.setMcpServerEnabledFailed'));
  }
};

/**
 * 注册 MCP 处理器
 */
export function registerMcpHandlers(registry: Map<string, MessageHandler>): void {
  registry.set(MESSAGE_NAMES.openMcpConfigFile, openMcpConfigFile);
  registry.set(MESSAGE_NAMES.getMcpServers, getMcpServers);
  registry.set(MESSAGE_NAMES.validateMcpServerId, validateMcpServerId);
  registry.set(MESSAGE_NAMES.createMcpServer, createMcpServer);
  registry.set(MESSAGE_NAMES.updateMcpServer, updateMcpServer);
  registry.set(MESSAGE_NAMES.deleteMcpServer, deleteMcpServer);
  registry.set(MESSAGE_NAMES.connectMcpServer, connectMcpServer);
  registry.set(MESSAGE_NAMES.disconnectMcpServer, disconnectMcpServer);
  registry.set(MESSAGE_NAMES.setMcpServerEnabled, setMcpServerEnabled);
}
