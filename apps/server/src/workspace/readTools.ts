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
import { createLiteralSearchTool } from './literalSearchTool';
import { normalizeToolArgs } from '../../../../backend/tools/coerceToolArgs';

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

/** 原批量读取、目录、glob、搜索替换实现直接用于独立任务。 */
export function readTools(app: PlatformApplication): RuntimeTool[] {
  const catalog = new NodeFileHost(app, { runId: 'catalog', actorId: 'owner', signal: new AbortController().signal,
    progress: () => {}, askUser: async () => { throw new Error('工具声明不执行询问。'); } });
  const factories: ((host: NodeFileHost) => Tool)[] = [
    host => createReadFileTool(host, true), host => createListFilesTool(host),
    host => createFindFilesRuntime(host).createFindFilesTool(), host => createSearchDeclaration(host).createSearchInFilesTool(),
    host => createLiteralSearchTool(host),
  ];
  return factories.map(factory => {
    const declaration = factory(catalog).declaration;
    return { declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
      normalizeArgs: args => normalizeToolArgs(declaration.name, args, declaration.parameters, {
        paramAliases: declaration.paramAliases, compatParams: declaration.compatParams,
      }),
      parallelRead: true,
      nativeAsync: declaration.name === 'search_in_files' ? false : true,
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
  });
}
