/**
 * 配置管理消息处理器
 */

import { t } from '../../backend/i18n';
import type { HandlerContext, MessageHandler } from '../types';
import type { CreateConfigInput, UpdateConfigInput } from '../../backend/modules/config/types';
import type {
  AddModelsRequest,
  GetModelsRequest,
  RemoveModelRequest,
  SetActiveModelRequest,
} from '../../backend/modules/api/models/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCreateConfigInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.name === 'string' && value.name.trim().length > 0
    && typeof value.type === 'string';
}

function isAddModelsRequest(value: unknown): value is AddModelsRequest {
  return isRecord(value)
    && typeof value.configId === 'string' && !!value.configId.trim()
    && Array.isArray(value.models);
}

function isModelSelectionRequest(value: unknown): value is RemoveModelRequest | SetActiveModelRequest {
  return isRecord(value)
    && typeof value.configId === 'string' && !!value.configId.trim()
    && typeof value.modelId === 'string' && !!value.modelId.trim();
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function requireString(
  value: unknown,
  requestId: string,
  ctx: HandlerContext,
  errorCode: string,
  fieldName: string
): value is string {
  if (typeof value === 'string' && value.trim().length > 0) return true;
  ctx.sendError(requestId, errorCode, `Invalid ${fieldName}`);
  return false;
}

export const listConfigs: MessageHandler = async (_data, requestId, ctx) => {
  try {
    const configs = await ctx.configManager.listConfigs();
    ctx.sendResponse(requestId, configs.map(config => config.id));
  } catch (error) {
    ctx.sendError(requestId, 'LIST_CONFIGS_ERROR', getErrorMessage(error, 'Failed to list configs'));
  }
};

export const getConfig: MessageHandler = async (data, requestId, ctx) => {
  const configId = data?.configId;
  if (!requireString(configId, requestId, ctx, 'GET_CONFIG_ERROR', 'configId')) return;
  try {
    ctx.sendResponse(requestId, await ctx.configManager.getConfig(configId));
  } catch (error) {
    ctx.sendError(requestId, 'GET_CONFIG_ERROR', getErrorMessage(error, 'Failed to get config'));
  }
};

export const createConfig: MessageHandler = async (data, requestId, ctx) => {
  if (!isCreateConfigInput(data)) {
    ctx.sendError(requestId, 'CREATE_CONFIG_ERROR', 'Invalid config data');
    return;
  }
  try {
    ctx.sendResponse(requestId, await ctx.configManager.createConfig(data as CreateConfigInput));
  } catch (error) {
    ctx.sendError(requestId, 'CREATE_CONFIG_ERROR', getErrorMessage(error, 'Failed to create config'));
  }
};

export const updateConfig: MessageHandler = async (data, requestId, ctx) => {
  const configId = data?.configId;
  const updates = data?.updates;
  // 两个独立校验步骤（R2-08 复查：原嵌套分支晦涩，configId/updates 错误混在一起）：
  // 1. configId 必须是非空字符串；2. updates 必须是普通对象——各自顺序 return 明确错误。
  if (!requireString(configId, requestId, ctx, 'UPDATE_CONFIG_ERROR', 'configId')) return;
  if (!isRecord(updates)) {
    ctx.sendError(requestId, 'UPDATE_CONFIG_ERROR', 'Invalid updates');
    return;
  }
  try {
    await ctx.configManager.updateConfig(configId, updates as UpdateConfigInput);
    ctx.sendResponse(requestId, { success: true });
  } catch (error) {
    ctx.sendError(requestId, 'UPDATE_CONFIG_ERROR', getErrorMessage(error, 'Failed to update config'));
  }
};

export const deleteConfig: MessageHandler = async (data, requestId, ctx) => {
  const configId = data?.configId;
  if (!requireString(configId, requestId, ctx, 'DELETE_CONFIG_ERROR', 'configId')) return;
  try {
    await ctx.configManager.deleteConfig(configId);
    ctx.sendResponse(requestId, { success: true });
  } catch (error) {
    ctx.sendError(requestId, 'DELETE_CONFIG_ERROR', getErrorMessage(error, 'Failed to delete config'));
  }
};

async function handleModelOperation(
  requestId: string,
  ctx: HandlerContext,
  errorCode: string,
  fallback: string,
  operation: () => Promise<any>,
  successData: (result: any) => unknown
): Promise<void> {
  try {
    const result = await operation();
    if (result?.success) {
      ctx.sendResponse(requestId, successData(result));
      return;
    }
    const message = typeof result?.error === 'string'
      ? result.error
      : result?.error?.message || fallback;
    ctx.sendError(requestId, errorCode, message);
  } catch (error) {
    ctx.sendError(requestId, errorCode, getErrorMessage(error, fallback));
  }
}

export const getModels: MessageHandler = async (data, requestId, ctx) => {
  const configId = data?.configId;
  if (!requireString(configId, requestId, ctx, 'GET_MODELS_ERROR', 'configId')) return;
  const request: GetModelsRequest = { configId };
  await handleModelOperation(requestId, ctx, 'GET_MODELS_ERROR', t('webview.errors.getModelsFailed'),
    () => ctx.modelsHandler.getModels(request), result => result.models);
};

export const addModels: MessageHandler = async (data, requestId, ctx) => {
  if (!isAddModelsRequest(data)) {
    ctx.sendError(requestId, 'ADD_MODELS_ERROR', 'Invalid model data');
    return;
  }
  await handleModelOperation(requestId, ctx, 'ADD_MODELS_ERROR', t('webview.errors.addModelsFailed'),
    () => ctx.modelsHandler.addModels(data), () => ({ success: true }));
};

export const removeModel: MessageHandler = async (data, requestId, ctx) => {
  if (!isModelSelectionRequest(data)) {
    ctx.sendError(requestId, 'REMOVE_MODEL_ERROR', 'Invalid model data');
    return;
  }
  await handleModelOperation(requestId, ctx, 'REMOVE_MODEL_ERROR', t('webview.errors.removeModelFailed'),
    () => ctx.modelsHandler.removeModel(data as RemoveModelRequest), () => ({ success: true }));
};

export const setActiveModel: MessageHandler = async (data, requestId, ctx) => {
  if (!isModelSelectionRequest(data)) {
    ctx.sendError(requestId, 'SET_ACTIVE_MODEL_ERROR', 'Invalid model data');
    return;
  }
  await handleModelOperation(requestId, ctx, 'SET_ACTIVE_MODEL_ERROR', t('webview.errors.setActiveModelFailed'),
    () => ctx.modelsHandler.setActiveModel(data as SetActiveModelRequest), () => ({ success: true }));
};

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
