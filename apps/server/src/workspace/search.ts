import { createHash, randomUUID } from 'node:crypto';
import type { DocumentState, ProjectReplacement, ProjectSearchQuery, ProjectSearchResult, WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import { buildExcludePattern } from '../../../../backend/tools/shared/globUtils';
import { projectSearchExpression, presentProjectSearch, searchProjectText } from '../../../../shared/projectSearch';
import { TextSearchWorker } from '../../../../backend/tools/search/textSearchWorker';
import { NodeFileHost } from './fileHost';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export class WorkspaceSearch {
  private readonly active = new Map<string, AbortController>();
  private readonly computations = new Set<TextSearchWorker>();
  private closing = false;
  constructor(private readonly app: PlatformApplication) {}
  private key(session: ClientSession, id: string) { return JSON.stringify([session.clientId, id]); }
  cancel(session: ClientSession, id: string) { this.active.get(this.key(session, id))?.abort(new Error('搜索已取消。')); }
  async close() {
    this.closing = true;
    for (const controller of this.active.values()) controller.abort(new Error('应用正在退出。'));
    await Promise.all([...this.computations].map(computation => computation.close()));
  }
  private async content(session: ClientSession, workspace: WorkspaceDefinition, file: string, drafts?: Map<string, DocumentState>) {
    // 读取本客户端的草稿；其他设备的编辑不混入本次查询。
    const draft = drafts ? drafts.get(file) : this.app.files.clientDocument(session.clientId, workspace.id, file);
    if (draft) await this.app.files.resolve(workspace, file);
    const text = (draft?.text ?? (await this.app.files.read(workspace, file)).text).replace(/^\uFEFF/, '');
    return { text, draft: draft?.dirty === true };
  }
  async search(session: ClientSession, workspaceId: string, requestId: string, options: ProjectSearchQuery): Promise<ProjectSearchResult> {
    if (this.closing) throw new Error('应用正在退出。');
    this.app.requireOwner(session.actorId);
    const workspace = this.app.workspace(session.actorId, workspaceId, ['workspace_read']);
    const expression = projectSearchExpression(options);
    if (typeof requestId !== 'string' || !requestId) throw new Error('搜索请求编号无效。');
    const key = this.key(session, requestId);
    this.active.get(key)?.abort();
    const controller = new AbortController(); this.active.set(key, controller);
    const computation = options.regex ? new TextSearchWorker({ signal: controller.signal }) : undefined;
    if (computation) this.computations.add(computation);
    try {
      const host = new NodeFileHost(this.app, { runId: requestId, actorId: session.actorId, workspace,
        signal: controller.signal, progress() {}, askUser: async () => { throw new Error('搜索不执行任务询问。'); } });
      const config = host.searchConfig();
      const fileLimit = Math.max(1, config.maxFindFiles ?? 1000);
      const matchLimit = 1000;
      const result: ProjectSearchResult = { files: [], count: 0, truncated: false, skipped: [] };
      const drafts = new Map(this.app.files.clientDocuments(session.clientId, workspaceId).map(document => [document.path, document]));
      let scanned = 0;
      for (const root of host.getAllWorkspaces()) {
        const files = host.iterateFiles(root.uri, options.include?.trim() || '**/*',
          buildExcludePattern([...config.excludePatterns ?? [], ...(options.exclude?.trim() ? [options.exclude.trim()] : [])]), fileLimit + 1);
        for await (const file of files) {
          controller.signal.throwIfAborted();
          if (scanned++ >= fileLimit) { result.truncated = true; return result; }
          const relative = host.toRelativePath(file);
          try {
            const value = await this.content(session, workspace, relative, drafts);
            controller.signal.throwIfAborted();
            const limit = matchLimit - result.count;
            const found = computation
              ? presentProjectSearch(value.text, (await computation.run({ kind: 'scan', source: expression.source, flags: expression.flags,
                fragments: [value.text], limit: limit + 1, previewChars: 300 })).matches, limit)
              : searchProjectText(value.text, expression, limit);
            controller.signal.throwIfAborted();
            if (found.matches.length) result.files.push({ path: relative, hash: hashText(value.text), draft: value.draft, matches: found.matches });
            result.count += found.matches.length;
            if (found.truncated) { result.truncated = true; return result; }
          } catch (error) { controller.signal.throwIfAborted(); result.skipped.push({ path: relative, reason: String(error) }); }
        }
      }
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (this.active.get(key) === controller) this.active.delete(key);
      if (computation) { await computation.close(); this.computations.delete(computation); }
    }
  }
  async replace(session: ClientSession, workspaceId: string, options: ProjectSearchQuery, replacement: string,
    selections: Array<{ path: string; hash: string }>): Promise<ProjectReplacement[]> {
    if (this.closing) throw new Error('应用正在退出。');
    this.app.requireOwner(session.actorId);
    const workspace = this.app.workspace(session.actorId, workspaceId, ['workspace_write']);
    if (typeof replacement !== 'string' || !Array.isArray(selections) || selections.length > 1000) throw new Error('替换参数无效。');
    const expression = projectSearchExpression(options);
    const key = this.key(session, 'replace:' + randomUUID()), controller = new AbortController();
    this.active.set(key, controller);
    const computation = options.regex ? new TextSearchWorker({ signal: controller.signal }) : undefined;
    if (computation) this.computations.add(computation);
    const edits: ProjectReplacement[] = []; const seen = new Set<string>(); let bytes = 0;
    try {
      for (const item of selections) {
        if (seen.has(item.path)) throw new Error('同一批替换不能重复选择文件。');
        seen.add(item.path);
        const current = await this.content(session, workspace, item.path);
        controller.signal.throwIfAborted();
        if (hashText(current.text) !== item.hash) throw new Error(`文件 ${item.path} 已变化，请重新搜索后再替换。`);
        const after = computation ? (await computation.run({ kind: 'replace', source: expression.source, flags: expression.flags,
          text: current.text, replacement, limit: 0, previewChars: 0 })).text! : current.text.replace(expression, () => replacement);
        controller.signal.throwIfAborted();
        bytes += Buffer.byteLength(current.text) + Buffer.byteLength(after);
        if (Buffer.byteLength(after) > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('替换内容超过编辑大小限制，请缩小文件范围。');
        if (after !== current.text) edits.push({ path: item.path, before: current.text, after });
      }
      // 只生成编辑方案，前端再次检查打开模型的内容后作为一批草稿应用。
      return edits;
    } finally {
      this.active.delete(key);
      if (computation) { await computation.close(); this.computations.delete(computation); }
    }
  }
}
