import { workspaceFilePath } from './paths';
import { uiWorkspace } from './uiFiles';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { fileHash } from './fileTransaction';

/** 用户主动打开或保存文件的界面入口，复用工作区路径和编辑草稿保护。 */
export function workspaceUiHandlers(app: PlatformApplication, client: ClientSession, selected?: WorkspaceDefinition) {
  const workspace = (data: Record<string, any>, write = false) => uiWorkspace(app, client, selected, data, write);
  async function open(data: Record<string, any>) {
    const target = await workspace(data);
    if (typeof data.path !== 'string' || !data.path.trim()) throw new Error('缺少文件路径。');
    const absolute = await app.files.resolve(target, data.path);
    const relative = workspaceFilePath(target, absolute);
    const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1;
    app.publish({ type: 'workspace.file.open', clientId: client.clientId, workspaceId: target.id, path: relative,
      selection: data.startLine ? { startLineNumber: positive(data.startLine), startColumn: positive(data.startCharacter),
        endLineNumber: Math.max(positive(data.startLine), positive(data.endLine ?? data.startLine)), endColumn: positive(data.endCharacter) } : undefined });
    return { success: true };
  }
  return {
    openWorkspaceFile: open,
    openWorkspaceFileAt: open,
    saveImageToPath: async (data: Record<string, any>) => {
      const target = await workspace(data, true);
      if (typeof data.path !== 'string' || typeof data.data !== 'string' || !data.data.length || data.data.length > Math.ceil(50 * 1024 * 1024 / 3) * 4)
        throw new Error('图片内容无效或超过 50 MiB。');
      const bytes = Buffer.from(data.data, 'base64');
      if (!bytes.length || bytes.toString('base64') !== data.data) throw new Error('图片不是有效的 Base64 数据。');
      await app.files.transaction(target, async transaction => {
        const before = await transaction.capture(data.path);
        await transaction.apply([{ path: data.path, before, after: { bytes, hash: fileHash(bytes), mode: before.mode } }]);
      });
      return { success: true };
    },
  };
}
