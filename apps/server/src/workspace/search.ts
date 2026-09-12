import { createHash } from 'node:crypto';
import type { ProjectReplacement, ProjectSearchQuery, ProjectSearchResult, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { buildExcludePattern } from '../../../../backend/tools/shared/globUtils';
import { projectSearchExpression, replaceProjectText, searchProjectText } from '../../../../shared/projectSearch';
import { NodeFileHost } from './fileHost';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export class WorkspaceSearch {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly app: PlatformApplication) {}
  private key(session: ClientSession, id: string) { return JSON.stringify([session.clientId, id]); }
  cancel(session: ClientSession, id: string) { this.active.get(this.key(session, id))?.abort(new Error('搜索已取消。')); }
  close() { for (const controller of this.active.values()) controller.abort(new Error('应用正在退出。')); }
  private async content(session: ClientSession, workspace: WorkspaceDefinition, file: string) {
    // 读取本客户端的草稿；其他设备的编辑不混入本次查询。
    await this.app.files.resolve(workspace, file);
    const draft = this.app.files.clientDocuments(session.clientId, workspace.id).find(item => item.path === file);
    const text = (draft?.text ?? (await this.app.files.read(workspace, file)).text).replace(/^\uFEFF/, '');
    return { text, hash: hashText(text), draft: draft?.dirty === true };
  }
  async search(session: ClientSession, workspaceId: string, requestId: string, options: ProjectSearchQuery): Promise<ProjectSearchResult> {
    this.app.requireOwner(session.actorId);
    const workspace = this.app.workspace(session.actorId, workspaceId, ['workspace_read']);
    projectSearchExpression(options);
    if (typeof requestId !== 'string' || !requestId) throw new Error('搜索请求编号无效。');
    const key = this.key(session, requestId);
    this.active.get(key)?.abort();
    const controller = new AbortController(); this.active.set(key, controller);
    const host = new NodeFileHost(this.app, { runId: requestId, actorId: session.actorId, workspace,
      signal: controller.signal, progress() {}, askUser: async () => { throw new Error('搜索不执行任务询问。'); } });
    const config = host.searchConfig();
    const fileLimit = Math.max(1, config.maxFindFiles ?? 1000);
    const matchLimit = 1000;
    const result: ProjectSearchResult = { files: [], count: 0, truncated: false, skipped: [] };
    try {
      let scanned = 0;
      for (const root of host.getAllWorkspaces()) {
        const files = await host.findFiles(root.uri, options.include?.trim() || '**/*',
          buildExcludePattern([...config.excludePatterns ?? [], ...(options.exclude?.trim() ? [options.exclude.trim()] : [])]), fileLimit + 1);
        for (const file of files) {
          controller.signal.throwIfAborted();
          if (scanned++ >= fileLimit) { result.truncated = true; return result; }
          const relative = host.toRelativePath(file);
          try {
            const value = await this.content(session, workspace, relative);
            const found = searchProjectText(value.text, options, matchLimit - result.count);
            if (found.matches.length) result.files.push({ path: relative, hash: value.hash, draft: value.draft, matches: found.matches });
            result.count += found.matches.length;
            if (found.truncated) { result.truncated = true; return result; }
          } catch (error) { controller.signal.throwIfAborted(); result.skipped.push({ path: relative, reason: String(error) }); }
        }
      }
      return result;
    } finally { if (this.active.get(key) === controller) this.active.delete(key); }
  }
  async replace(session: ClientSession, workspaceId: string, options: ProjectSearchQuery, replacement: string,
    selections: Array<{ path: string; hash: string }>): Promise<ProjectReplacement[]> {
    this.app.requireOwner(session.actorId);
    const workspace = this.app.workspace(session.actorId, workspaceId, ['workspace_write']);
    if (typeof replacement !== 'string' || !Array.isArray(selections) || selections.length > 1000) throw new Error('替换参数无效。');
    projectSearchExpression(options);
    const edits: ProjectReplacement[] = []; const seen = new Set<string>(); let bytes = 0;
    for (const item of selections) {
      if (seen.has(item.path)) throw new Error('同一批替换不能重复选择文件。');
      seen.add(item.path);
      const current = await this.content(session, workspace, item.path);
      if (current.hash !== item.hash) throw new Error(`文件 ${item.path} 已变化，请重新搜索后再替换。`);
      const after = replaceProjectText(current.text, options, replacement);
      bytes += Buffer.byteLength(current.text) + Buffer.byteLength(after);
      if (Buffer.byteLength(after) > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('替换内容超过编辑大小限制，请缩小文件范围。');
      if (after !== current.text) edits.push({ path: item.path, before: current.text, after });
    }
    // 只生成编辑方案，前端再次检查打开模型的内容后作为一批草稿应用。
    return edits;
  }
}
