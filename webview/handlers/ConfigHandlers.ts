/**
 * 配置管理消息处理器
 */

import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';

/**
 * 列出所有配置
 */
export const listConfigs: MessageHandler = async (data, requestId, ctx) => {
  const configs = await ctx.configManager.listConfigs();
  const configIds = configs.map(c => c.id);
  ctx.sendResponse(requestId, configIds);
};

/**
 * 获取配置
 */
export const getConfig: MessageHandler = async (data, requestId, ctx) => {
  const { configId } = data;
  const config = await ctx.configManager.getConfig(configId);
  ctx.sendResponse(requestId, config);
};

/**
 * 创建配置
 */
export const createConfig: MessageHandler = async (data, requestId, ctx) => {
  const configId = await ctx.configManager.createConfig(data);
  ctx.sendResponse(requestId, configId);
};

/**
 * 更新配置
 */
export const updateConfig: MessageHandler = async (data, requestId, ctx) => {
  const { configId, updates } = data;
  await ctx.configManager.updateConfig(configId, updates);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 删除配置
 */
export const deleteConfig: MessageHandler = async (data, requestId, ctx) => {
  const { configId } = data;
  await ctx.configManager.deleteConfig(configId);
  ctx.sendResponse(requestId, { success: true });
};

/**
 * 获取模型列表
 */
export const getModels: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.modelsHandler.getModels(data);
  if (result.success) {
    ctx.sendResponse(requestId, result.models);
  } else {
    ctx.sendError(requestId, 'GET_MODELS_ERROR', typeof result.error === 'string' ? result.error : (result.error?.message || t('webview.errors.getModelsFailed')));
  }
};

/**
 * 添加模型
 */
export const addModels: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.modelsHandler.addModels(data);
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'ADD_MODELS_ERROR', typeof result.error === 'string' ? result.error : (result.error?.message || t('webview.errors.addModelsFailed')));
  }
};

/**
 * 移除模型
 */
export const removeModel: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.modelsHandler.removeModel(data);
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'REMOVE_MODEL_ERROR', typeof result.error === 'string' ? result.error : (result.error?.message || t('webview.errors.removeModelFailed')));
  }
};

/**
 * 设置活动模型
 */
export const setActiveModel: MessageHandler = async (data, requestId, ctx) => {
  const result = await ctx.modelsHandler.setActiveModel(data);
  if (result.success) {
    ctx.sendResponse(requestId, { success: true });
  } else {
    ctx.sendError(requestId, 'SET_ACTIVE_MODEL_ERROR', typeof result.error === 'string' ? result.error : (result.error?.message || t('webview.errors.setActiveModelFailed')));
  }
};

/**
 * 注册配置管理处理器
 */
export function registerConfigHandlers(registry: Map<string, MessageHandler>): void {
  registry.set('config.listConfigs', listConfigs);
  registry.set('config.getConfig', getConfig);
  registry.set('config.createConfig', createConfig);
  registry.set('config.updateConfig', updateConfig);
  registry.set('config.deleteConfig', deleteConfig);
  registry.set('models.getModels', getModels);
  registry.set('models.addModels', addModels);
  registry.set('models.removeModel', removeModel);
  registry.set('models.setActiveModel', setActiveModel);
}
