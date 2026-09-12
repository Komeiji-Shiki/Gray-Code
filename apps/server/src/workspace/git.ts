import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { GitBranch, GitEntry, GitStatus, GitWorktree, GitWorktreeCreate, WorkspaceDefinition } from '@graycode/contracts';
import type { WorkspaceFiles } from './files';
import { inside, workspaceForRoot } from './paths';

const execute = promisify(execFile);
const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export class WorkspaceGit {
  constructor(private readonly files: WorkspaceFiles) {}
  private async run(workspace: WorkspaceDefinition, args: string[], difference = false): Promise<string> {
    try {
      return (await execute('git', ['--no-pager', '--literal-pathspecs', ...args], {
        cwd: workspace.directory, windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })).stdout;
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string };
      if (difference && result.code === 1) return result.stdout ?? '';
      throw Object.assign(new Error(result.stderr?.trim() || result.message), { code: result.code });
    }
  }
  private async entries(root: WorkspaceDefinition): Promise<GitEntry[]> {
    const chunks = (await this.run(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
    const entries: GitEntry[] = [];
    for (let index = 0; index < chunks.length; index++) {
      const value = chunks[index]; if (!value) continue;
      entries.push({ index: value[0], worktree: value[1], path: value.slice(3), conflict: conflicts.has(value.slice(0, 2)),
        ...(/[RC]/.test(value.slice(0, 2)) ? { originalPath: chunks[++index] } : {}) });
    }
    return entries;
  }
  private async head(root: WorkspaceDefinition): Promise<string | undefined> {
    try { return (await this.run(root, ['rev-parse', '--verify', 'HEAD'])).trim(); }
    catch (error) { if ((error as { code?: number }).code === 128) return undefined; throw error; }
  }
  private async repository(root: WorkspaceDefinition): Promise<boolean> {
    let directory: string;
    try { directory = (await this.run(root, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) { if (/not a git repository/i.test((error as Error).message)) return false; throw error; }
    if (path.relative(await realpath(root.directory), await realpath(directory)) !== '') throw new Error(`请选择仓库根目录进行 Git 操作：${directory}`);
    return true;
  }
  private async requireRepository(root: WorkspaceDefinition) {
    if (!await this.repository(root)) throw new Error('当前目录还没有 Git 仓库，请先初始化。');
  }
  private async branches(root: WorkspaceDefinition): Promise<GitBranch[]> {
    const value = await this.run(root, ['for-each-ref', '--format=%(refname:short)%00%(upstream:short)%00%(worktreepath)%00', 'refs/heads']);
    return value.split('\0\n').filter(Boolean).map(record => {
      const [name, upstream, worktree] = record.split('\0'); return { name, upstream: upstream || undefined, worktree: worktree || undefined };
    });
  }
  private async worktrees(root: WorkspaceDefinition): Promise<GitWorktree[]> {
    const value = await this.run(root, ['worktree', 'list', '--porcelain', '-z']);
    return value.split('\0\0').filter(Boolean).map((record, index) => {
      const entry: GitWorktree = { directory: '', main: index === 0 };
      for (const field of record.split('\0')) {
        const space = field.indexOf(' '), key = space < 0 ? field : field.slice(0, space), content = space < 0 ? '' : field.slice(space + 1);
        if (key === 'worktree') entry.directory = content;
        else if (key === 'HEAD') entry.commit = content;
        else if (key === 'branch') entry.branch = content.replace(/^refs\/heads\//, '');
        else if (key === 'detached' || key === 'bare') entry[key] = true;
        else if (key === 'locked' || key === 'prunable') entry[key] = content || key;
      }
      return entry;
    });
  }
  async status(workspace: WorkspaceDefinition, directory?: string): Promise<GitStatus> {
    const root = workspaceForRoot(workspace, directory);
    const absolute = await realpath(root.directory);
    if (!await this.repository(root)) return { repository: false, branch: '', entries: [], branches: [], worktrees: [], dirtyFiles: this.files.dirtyPathsInDirectory(absolute) };
    await this.files.reloadCleanDocuments(absolute);
    const [entries, branch, commit, branches, worktrees] = await Promise.all([
      this.entries(root), this.run(root, ['branch', '--show-current']), this.head(root), this.branches(root), this.worktrees(root),
    ]);
    return { repository: true, entries, branch: branch.trim(), commit, branches, worktrees, dirtyFiles: this.files.dirtyPathsInDirectory(absolute) };
  }
  async init(workspace: WorkspaceDefinition, branch: string, directory?: string): Promise<void> {
    const root = workspaceForRoot(workspace, directory);
    await this.files.transaction(workspace, async () => {
      if (await this.repository(root)) return;
      if (branch) await this.branchName(root, branch);
      await this.run(root, ['init', ...(branch ? ['--initial-branch', branch] : [])]);
    });
  }
  async diff(workspace: WorkspaceDefinition, file: string, staged = false, directory?: string): Promise<string> {
    const root = workspaceForRoot(workspace, directory);
    await this.requireRepository(root);
    await this.files.resolveEntry(root, file);
    const entry = (await this.entries(root)).find(entry => entry.path === file);
    const options = ['--no-ext-diff', '--no-textconv'];
    if (entry?.index === '?' && !staged) {
      await this.files.resolve(root, file);
      return this.run(root, ['diff', '--no-index', ...options, '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file], true);
    }
    return this.run(root, ['diff', ...options, ...(staged ? ['--cached'] : []), '--', file, ...entry?.originalPath ? [entry.originalPath] : []]);
  }
  async stage(workspace: WorkspaceDefinition, file: string, staged: boolean, directory?: string): Promise<void> {
    const root = workspaceForRoot(workspace, directory);
    await this.files.transaction(workspace, async () => {
      await this.requireRepository(root);
      await this.files.resolveEntry(root, file);
      const entry = (await this.entries(root)).find(entry => entry.path === file);
      if (!entry) throw new Error('文件状态已经变化，请刷新后重试。');
      const files = [file, ...entry.originalPath ? [entry.originalPath] : []];
      for (const target of files) await this.files.resolveEntry(root, target);
      // 初始提交前没有 HEAD；取消暂存只移除索引项，保留工作区文件。
      const command = staged ? ['add'] : await this.head(root) ? ['restore', '--staged'] : ['rm', '--cached', '--ignore-unmatch', '-f'];
      await this.run(root, [...command, '--', ...files]);
    });
  }
  async commit(workspace: WorkspaceDefinition, message: string, directory?: string): Promise<string> {
    const root = workspaceForRoot(workspace, directory);
    if (typeof message !== 'string' || !message.trim()) throw new Error('请输入提交说明。');
    return this.files.transaction(workspace, async () => {
      await this.requireRepository(root);
      if ((await this.entries(root)).some(entry => entry.conflict)) throw new Error('请先解决冲突并暂存文件，再提交。');
      return this.run(root, ['commit', '-m', message]);
    });
  }
  private async branchName(root: WorkspaceDefinition, name: string) {
    if (typeof name !== 'string' || !name.trim() || name.startsWith('-')) throw new Error('请输入有效分支名。');
    await this.run(root, ['check-ref-format', '--branch', name]);
  }
  private async startPoint(root: WorkspaceDefinition, value?: string) {
    if (!value) return undefined;
    return (await this.run(root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`])).trim();
  }
  async switchBranch(workspace: WorkspaceDefinition, branch: string, create: boolean, startPoint?: string, directory?: string) {
    const root = workspaceForRoot(workspace, directory), absolute = await realpath(root.directory);
    await this.branchName(root, branch);
    return this.files.transaction(workspace, async () => {
      await this.requireRepository(root);
      const base = create ? await this.startPoint(root, startPoint) : undefined;
      if (!create && !(await this.branches(root)).some(item => item.name === branch)) throw new Error('请选择现有本地分支，或明确创建新分支。');
      const result = await this.run(root, create ? ['switch', '--no-guess', '-c', branch, ...base ? [base] : []] : ['switch', '--no-guess', '--', branch]);
      await this.files.reloadCleanDocuments(absolute);
      return result;
    }, { rejectDirty: true, dirtyDirectory: absolute }).catch(error => {
      if (error.code === 'DOCUMENT_DIRTY') throw new Error('当前仓库还有未保存编辑，请先在对应窗口保存或关闭文件，再切换分支。');
      throw error;
    });
  }
  async createWorktree(workspace: WorkspaceDefinition, input: GitWorktreeCreate, directory?: string): Promise<GitWorktree> {
    const root = workspaceForRoot(workspace, directory);
    await this.requireRepository(root);
    if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0')) throw new Error('请填写新工作树的绝对路径。');
    await this.branchName(root, input.branch);
    const target = await this.files.resolveAbsolute(input.path), source = await realpath(root.directory);
    const metadata = await this.files.resolveAbsolute(path.resolve(root.directory, (await this.run(root, ['rev-parse', '--git-common-dir'])).trim()));
    if (inside(target, source) || inside(metadata, target)) throw new Error('工作树目录不能覆盖现有仓库，也不能位于 Git 内部目录。');
    return this.files.transaction(workspace, async () => {
      try {
        if (!(await lstat(target)).isDirectory() || (await readdir(target)).length) throw new Error('请选择不存在的新目录或空文件夹。');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const base = input.createBranch ? await this.startPoint(root, input.startPoint) : undefined;
      if (!input.createBranch && !(await this.branches(root)).some(branch => branch.name === input.branch)) throw new Error('所选本地分支不存在。');
      await this.run(root, ['worktree', 'add', '--no-guess-remote', ...input.createBranch ? ['-b', input.branch] : [], '--', target,
        ...input.createBranch ? base ? [base] : [] : [input.branch]]);
      const created = (await this.worktrees(root)).find(item => path.relative(item.directory, target) === '');
      if (!created) throw new Error('工作树创建完成，但 Git 没有返回对应记录，请刷新列表。');
      return created;
    });
  }
  async removeWorktree(workspace: WorkspaceDefinition, target: string, directory?: string): Promise<void> {
    const root = workspaceForRoot(workspace, directory);
    await this.files.transaction(workspace, async () => {
      await this.requireRepository(root);
      const entry = (await this.worktrees(root)).find(item => path.relative(item.directory, target) === '');
      if (!entry || entry.main || path.relative(root.directory, entry.directory) === '') throw new Error('只能移除列表中的其他工作树，不能移除主目录或当前目录。');
      if (entry.locked || entry.prunable) throw new Error('工作树已锁定或需要修复，请先处理它的状态。');
      const absolute = await realpath(entry.directory);
      if (this.files.dirtyPathsInDirectory(absolute).length) throw new Error('工作树中还有未保存的编辑，请先保存或关闭对应文件。');
      const targetRoot = { ...root, directory: absolute };
      if ((await this.run(targetRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'])).length)
        throw new Error('工作树还有修改、未跟踪或忽略的文件，请先保留所需内容。');
      await this.run(root, ['worktree', 'remove', '--', absolute]);
      await this.files.reloadCleanDocuments(absolute);
    });
  }
}
