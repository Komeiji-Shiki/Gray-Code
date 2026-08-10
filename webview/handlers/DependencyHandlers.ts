/**
 * 依赖管理消息处理器
 */

import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 列出所有依赖
 */
export const listDependencies: MessageHandler = async (data, requestId, ctx) => {
  try {
    const dependencies = await ctx.dependencyManager.listDependencies();
    ctx.sendResponse(requestId, { dependencies });
  } catch (error: any) {
    ctx.sendError(requestId, 'LIST_DEPENDENCIES_ERROR', error.message || t('webview.errors.listDependenciesFailed'));
  }
};

/**
 * 安装依赖
 */
export const installDependency: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { name } = data || {};
    // 前置校验 name 非空字符串（R2-08 复查：缺失时后端会收到 undefined）
    if (typeof name !== 'string' || !name.trim()) {
      ctx.sendError(requestId, 'INSTALL_DEPENDENCY_ERROR', 'name is required');
      return;
    }
    const success = await ctx.dependencyManager.install(name);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'INSTALL_DEPENDENCY_ERROR', error.message || t('webview.errors.installDependencyFailed'));
  }
};

/**
 * 卸载依赖
 */
export const uninstallDependency: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { name } = data || {};
    // 前置校验 name 非空字符串（R2-08 复查）
    if (typeof name !== 'string' || !name.trim()) {
      ctx.sendError(requestId, 'UNINSTALL_DEPENDENCY_ERROR', 'name is required');
      return;
    }
    const success = await ctx.dependencyManager.uninstall(name);
    ctx.sendResponse(requestId, { success });
  } catch (error: any) {
    ctx.sendError(requestId, 'UNINSTALL_DEPENDENCY_ERROR', error.message || t('webview.errors.uninstallDependencyFailed'));
  }
};

/**
 * 获取安装路径
 */
export const getInstallPath: MessageHandler = async (data, requestId, ctx) => {
  try {
    const path = ctx.dependencyManager.getInstallPath();
    ctx.sendResponse(requestId, { path });
  } catch (error: any) {
    ctx.sendError(requestId, 'GET_INSTALL_PATH_ERROR', error.message || t('webview.errors.getInstallPathFailed'));
  }
};

/**
 * 注册依赖管理处理器
 */
export function registerDependencyHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('dependencies.list', listDependencies);
  registry.set('dependencies.install', installDependency);
  registry.set('dependencies.uninstall', uninstallDependency);
  registry.set('dependencies.getInstallPath', getInstallPath);
}
