import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import type { Tool } from '../../../../backend/tools/types';
import { createReadFileTool } from '../../../../backend/tools/file/readFileRuntime';
import { createListFilesTool } from '../../../../backend/tools/file/listFilesRuntime';
import { createFindFilesRuntime } from '../../../../backend/tools/search/findFilesRuntime';
import { createSearchDeclaration } from '../../../../backend/tools/search/declarationRuntime';
import { FileReadAccess } from './readAccess';
import { NodeFileHost } from './fileHost';

/** 原批量读取、目录、glob、搜索替换实现直接用于独立任务。 */
export function readTools(app: PlatformApplication): RuntimeTool[] {
  const catalog = new NodeFileHost(app, { runId: 'catalog', actorId: 'owner', signal: new AbortController().signal,
    progress: () => {}, askUser: async () => { throw new Error('工具声明不执行询问。'); } });
  const factories: ((host: NodeFileHost) => Tool)[] = [
    host => createReadFileTool(host, true), host => createListFilesTool(host),
    host => createFindFilesRuntime(host).createFindFilesTool(), host => createSearchDeclaration(host).createSearchInFilesTool(),
  ];
  return factories.map(factory => {
    const declaration = factory(catalog).declaration;
    return { declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
      effects: args => declaration.name === 'search_in_files' && args.mode === 'replace' ? ['workspace_write'] : ['workspace_read'],
      execute: async (args, context: ToolContext) => {
        const readAccess = declaration.name === 'search_in_files' && args.mode === 'replace' ? undefined : new FileReadAccess(app, context);
        const tool = factory(new NodeFileHost(app, context, readAccess));
        const { multimodal, ...result } = await tool.handler(args, { conversationId: context.conversationId, toolId: context.toolCallId,
          abortSignal: context.signal, activeWorkspaceUri: context.workspace?.directory, approvedByToolConfirmation: context.approvedByToolConfirmation });
        return { ...result, attachments: multimodal };
      } } as RuntimeTool;
  });
}
