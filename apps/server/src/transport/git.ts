import type { PlatformApplication } from '../application';
import type { ClientSession } from './router';
import { inside, workspaceRoots } from '../workspace/paths';

/** Git 操作沿用工作区授权；工作树目录必须来自用户输入或该仓库的真实列表。 */
export async function gitRequest(app: PlatformApplication, session: ClientSession, method: string, params: Record<string, any>) {
  app.requireOwner(session.actorId);
  const workspace = app.workspace(session.actorId, params.workspaceId, [method === 'git.status' || method === 'git.diff' ? 'workspace_read' : 'workspace_write']);
  let result: unknown;
  switch (method) {
    case 'git.status': return app.git.status(workspace, params.directory);
    case 'git.diff': return app.git.diff(workspace, params.path, params.staged === true, params.directory);
    case 'git.init': result = await app.git.init(workspace, params.branch ?? '', params.directory); break;
    case 'git.stage': result = await app.git.stage(workspace, params.path, params.staged === true, params.directory); break;
    case 'git.commit': result = await app.git.commit(workspace, params.message, params.directory); break;
    case 'git.switch': result = await app.git.switchBranch(workspace, params.branch, params.create === true, params.startPoint, params.directory); break;
    case 'git.worktree.create': result = await app.git.createWorktree(workspace, params.input, params.directory); break;
    case 'git.worktree.remove': {
      const directory = await app.files.resolveAbsolute(params.path);
      const registered = app.settings.snapshot().settings.workspaces.find(item => workspaceRoots(item).some(root => inside(directory, root.directory)));
      if (registered) throw new Error(`工作树仍用作项目目录（${registered.name}），请先在工作区设置中移除该目录。`);
      result = await app.git.removeWorktree(workspace, directory, params.directory); break;
    }
    default: throw new Error('未知 Git 操作。');
  }
  app.publish({ type: 'workspace.git.changed', workspaceId: workspace.id, directory: params.directory ?? workspace.directory });
  return result;
}
