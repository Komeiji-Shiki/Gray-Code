import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkspaceDefinition } from "@graycode/contracts";
import type { WorkspaceFiles } from "./files";
const execute = promisify(execFile);
export class WorkspaceGit {
  constructor(private readonly files: WorkspaceFiles) {}
  private async run(workspace: WorkspaceDefinition, args: string[]) {
    const result = await execute("git", ["--no-pager", ...args], {
      cwd: workspace.directory,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout;
  }
  async status(workspace: WorkspaceDefinition) {
    const output = await this.run(workspace, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]);
    const entries: {
      index: string;
      worktree: string;
      path: string;
      originalPath?: string;
    }[] = [];
    const chunks = output.split("\0");
    for (let i = 0; i < chunks.length; i++) {
      const entry = chunks[i];
      if (!entry) continue;
      entries.push({
        index: entry[0],
        worktree: entry[1],
        path: entry.slice(3),
        ...(/[RC]/.test(entry.slice(0, 2))
          ? { originalPath: chunks[++i] }
          : {}),
      });
    }
    return {
      branch: (await this.run(workspace, ["branch", "--show-current"])).trim(),
      entries,
    };
  }
  async diff(
    workspace: WorkspaceDefinition,
    file: string,
    staged = false,
  ): Promise<string> {
    await this.files.resolve(workspace, file);
    return this.run(workspace, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...(staged ? ["--cached"] : []),
      "--",
      file,
    ]);
  }
  async stage(
    workspace: WorkspaceDefinition,
    file: string,
    staged: boolean,
  ): Promise<void> {
    await this.files.resolve(workspace, file);
    await this.run(
      workspace,
      staged ? ["add", "--", file] : ["restore", "--staged", "--", file],
    );
  }
  async commit(
    workspace: WorkspaceDefinition,
    message: string,
  ): Promise<string> {
    if (!message.trim()) throw new Error("请输入提交说明。");
    return this.run(workspace, ["commit", "-m", message]);
  }
}
