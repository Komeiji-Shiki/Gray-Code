import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { Tool } from '../../../../backend/tools/types';
import { createReadFileTool } from '../../../../backend/tools/file/readFileRuntime';
import { createListFilesTool } from '../../../../backend/tools/file/listFilesRuntime';
import { createFindFilesRuntime } from '../../../../backend/tools/search/findFilesRuntime';
import { createSearchDeclaration } from '../../../../backend/tools/search/declarationRuntime';
import { getMultimodalCapability, type MultimodalCapability } from '../../../../backend/tools/shared/multimodal';
import { FileReadAccess } from './readAccess';
import { NodeFileHost } from './fileHost';
import { normalizeToolArgs } from '../../../../backend/tools/coerceToolArgs';
import { SEARCH_IN_FILES_REPLACE_APPROVAL } from '../../../../backend/modules/settings/modeToolsPolicy';

/**
 * 桌面与 Web 版默认启用多模态工具：渠道设置不再提供该开关，
 * 读取图片/PDF 的能力按所选供应方协议计算。
 * 供应方缺失或协议未知时保守支持全部类型，实际格式仍以端点为准。
 */
function readMultimodalCapability(app: PlatformApplication, context: ToolContext): MultimodalCapability {
  const providerId = context.modelSelection?.providerId || context.agent?.providerId;
  const protocol = providerId
    ? app.settings.find('providers', providerId)?.protocol
    : undefined;
  return protocol
    ? getMultimodalCapability(protocol, 'function_call', true)
    : { supportsImages: true, supportsDocuments: true, supportsHistoryMultimodal: true };
}

/** 声明只来自宿主无关的工厂调用，不读取文件或执行询问。 */
function declarationHost(app: PlatformApplication) {
  return new NodeFileHost(app, { runId: 'catalog', actorId: 'owner', signal: new AbortController().signal,
    progress: () => {}, askUser: async () => { throw new Error('工具声明不执行询问。'); } });
}

/** 原批量读取、目录、glob、搜索替换实现直接用于独立任务。 */
export function readTools(app: PlatformApplication): RuntimeTool[] {
  const catalog = declarationHost(app);
  const factories: ((host: NodeFileHost) => Tool)[] = [
    host => createReadFileTool(host, true), host => createListFilesTool(host),
    host => createFindFilesRuntime(host).createFindFilesTool(), host => createSearchDeclaration(host).createSearchInFilesTool(),
  ];
  return factories.map(factory => readTool(app, factory, factory(catalog).declaration));
}

/**
 * 只授予搜索的模式（Ask、Review 等）使用的 search_in_files：声明不再列出替换参数，
 * 校验与执行沿用完整工具，替换调用仍由运行器按审批规则拒绝。
 */
export function readOnlySearchTool(app: PlatformApplication): RuntimeTool {
  const catalog = declarationHost(app);
  const factory = (host: NodeFileHost) => createSearchDeclaration(host).createSearchInFilesTool();
  const readOnly = createSearchDeclaration(catalog).createSearchInFilesTool({ readOnly: true }).declaration;
  return readTool(app, factory, readOnly, factory(catalog).declaration.parameters);
}

/** parameters 用于参数规范化与校验；只读声明省略的替换参数仍按完整 schema 处理，交给审批拒绝而不是被静默剥离。 */
function readTool(app: PlatformApplication, factory: (host: NodeFileHost) => Tool, declaration: Tool['declaration'],
  parameters = declaration.parameters): RuntimeTool {
  return { declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
    ...(parameters !== declaration.parameters ? { validationSchema: parameters } : {}),
    normalizeArgs: args => normalizeToolArgs(declaration.name, args, parameters, {
      paramAliases: declaration.paramAliases, compatParams: declaration.compatParams,
    }),
    parallelRead: true,
    nativeAsync: declaration.name === 'search_in_files' ? false : true,
    ...(declaration.name === 'search_in_files'
      ? { approvalName: (args: Record<string, unknown>) => args.mode === 'replace' ? SEARCH_IN_FILES_REPLACE_APPROVAL : declaration.name }
      : {}),
    effects: args => declaration.name === 'search_in_files' && args.mode === 'replace' ? ['workspace_write'] : ['workspace_read'],
    execute: async (args, context: ToolContext) => {
      const readAccess = declaration.name === 'search_in_files' && args.mode === 'replace' ? undefined : new FileReadAccess(app, context);
      const tool = factory(new NodeFileHost(app, context, readAccess));
      const { multimodal, ...result } = await tool.handler(args, { conversationId: context.conversationId, toolId: context.toolCallId,
        abortSignal: context.signal, activeWorkspaceUri: context.workspace?.directory, approvedByToolConfirmation: context.approvedByToolConfirmation,
        // 平台版默认启用多模态：此前未注入能力，read_file 声明支持图片却在执行时一律拒绝。
        multimodalEnabled: true, capability: readMultimodalCapability(app, context) });
      return { ...result, attachments: multimodal };
    } } as RuntimeTool;
}
