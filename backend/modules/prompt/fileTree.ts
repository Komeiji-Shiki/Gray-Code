import * as vscode from 'vscode'
import { FILE_TREE_MAX_NODES, getSingleWorkspaceFileTree, type WorkspaceInfo } from './workspaceFileTree'
export * from './workspaceFileTree'
/**
 * 获取工作区文件目录结构（支持多工作区）
 * @param maxDepth 最大深度
 * @param customIgnorePatterns 自定义忽略模式
 * @returns 文件列表字符串，一行一个
 */
export function getWorkspaceFileTree(maxDepth: number = 2, customIgnorePatterns: string[] = [], nodeBudget: number = FILE_TREE_MAX_NODES): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return ''
    }
    
    // 单工作区模式
    if (workspaceFolders.length === 1) {
        return getSingleWorkspaceFileTree(workspaceFolders[0].uri.fsPath, maxDepth, customIgnorePatterns, nodeBudget)
    }
    
    // 多工作区模式：总节点预算按根均分（余数给第一个根），避免每根各用完整预算
    // 导致总节点数达 N×10000（04 批 LOW）。均分后每根预算固定，缓存 key（含
    // nodeBudget）依然稳定可复用；共享 budget 对象会让缓存 key 随已消耗量漂移，无法复用 TTL 缓存。
    const sections: string[] = []
    const rootCount = workspaceFolders.length
    const perRootBudget = Math.max(0, Math.floor(nodeBudget / rootCount))
    
    for (let i = 0; i < rootCount; i++) {
        const folder = workspaceFolders[i]
        const workspaceName = folder.name
        const workspacePath = folder.uri.fsPath
        // 第一个根吸收均分余数，保证多根总预算恰为 nodeBudget
        const budget = i === 0 ? nodeBudget - perRootBudget * (rootCount - 1) : perRootBudget
        const fileTree = getSingleWorkspaceFileTree(workspacePath, maxDepth, customIgnorePatterns, budget)
        
        if (fileTree) {
            // 添加工作区标题和缩进的文件树
            sections.push(`[${workspaceName}]`)
            // 给每行添加缩进
            const indentedTree = fileTree.split('\n').map(line => '  ' + line).join('\n')
            sections.push(indentedTree)
        }
    }
    
    return sections.join('\n\n')
}

/**
 * 获取所有工作区信息
 */
export function getAllWorkspaces(): WorkspaceInfo[] {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return []
    }
    
    return workspaceFolders.map(folder => ({
        name: folder.name,
        fsPath: folder.uri.fsPath
    }))
}

/**
 * 获取工作区根目录路径（默认返回第一个）
 */
export function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined
    }
    return workspaceFolders[0].uri.fsPath
}
