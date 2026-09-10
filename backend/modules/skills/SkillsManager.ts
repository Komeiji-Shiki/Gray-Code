import * as vscode from 'vscode';
import { SkillsRuntime } from './SkillsRuntime';

/** 扩展只注入工作区来源，技能扫描与解析由共享实现负责。 */
export class SkillsManager extends SkillsRuntime {
    constructor(options: { workspacePath?: string; globalStoragePath: string }) {
        super({ ...options, host: {
            workspacePaths: () => (vscode.workspace?.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
            onWorkspaceChange: typeof vscode.workspace?.onDidChangeWorkspaceFolders === 'function'
                ? listener => vscode.workspace.onDidChangeWorkspaceFolders(listener) : undefined,
        } });
    }
}

// 全局实例
let globalSkillsManager: SkillsManager | null = null;

/**
 * 获取全局 SkillsManager 实例
 */
export function getSkillsManager(): SkillsManager | null {
    return globalSkillsManager;
}

/**
 * 设置全局 SkillsManager 实例（createSkillsManager 初始化完成后调用）
 */
export function setSkillsManager(manager: SkillsManager | null): void {
    globalSkillsManager = manager;
}

export async function createSkillsManager(options: {
    workspacePath?: string;
    globalStoragePath: string;
}): Promise<SkillsManager> {
    const manager = new SkillsManager(options);
    await manager.initialize();
    setSkillsManager(manager);
    return manager;
}

