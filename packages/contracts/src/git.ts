export interface GitEntry { path: string; index: string; worktree: string; originalPath?: string; conflict: boolean }
export interface GitBranch { name: string; upstream?: string; worktree?: string }
export interface GitWorktree { directory: string; commit?: string; branch?: string; detached?: boolean; bare?: boolean; locked?: string; prunable?: string; main: boolean }
export interface GitStatus {
  repository: boolean;
  branch: string;
  commit?: string;
  entries: GitEntry[];
  branches: GitBranch[];
  worktrees: GitWorktree[];
  dirtyFiles: string[];
}
export interface GitWorktreeCreate { path: string; branch: string; createBranch: boolean; startPoint?: string }
