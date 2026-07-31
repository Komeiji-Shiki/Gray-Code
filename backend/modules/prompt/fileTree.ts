/**
 * 文件目录树工具 - 获取工作区文件列表，支持 gitignore 排除
 *
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { globPatternToRegExp } from './glob'

/**
 * 工作区信息
 */
interface WorkspaceInfo {
    name: string;
    fsPath: string;
}

/**
 * 解析 .gitignore 文件，返回排除规则
 */
function parseGitignore(gitignorePath: string): string[] {
    if (!fs.existsSync(gitignorePath)) {
        return []
    }
    
    const content = fs.readFileSync(gitignorePath, 'utf8')
    const lines = content.split('\n')
    const patterns: string[] = []
    
    for (const line of lines) {
        const trimmed = line.trim()
        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith('#')) {
            continue
        }
        patterns.push(trimmed)
    }
    
    return patterns
}

/**
 * 检查文件/目录是否应该被忽略
 */
function shouldIgnore(relativePath: string, patterns: string[], isDirectory: boolean, customIgnorePatterns: string[] = []): boolean {
    const baseName = path.basename(relativePath)
    
    // 检查是否在自定义忽略列表中（从配置中获取）
    for (const ignore of customIgnorePatterns) {
        if (ignore.includes('*')) {
            // 通配符模式 - 支持 ** 匹配任意目录层级（gitignore 式：**/x 也匹配根级 x，* 不跨目录段）
            const regexStr = globPatternToRegExp(ignore)
            
            const regex = new RegExp(`^${regexStr}$|/${regexStr}$|^${regexStr}/|/${regexStr}/`, 'i')
            if (regex.test(relativePath.replace(/\\/g, '/')) || regex.test(baseName)) {
                return true
            }
        } else if (baseName === ignore || relativePath === ignore) {
            return true
        }
    }
    
    // 检查 gitignore 规则
    for (const pattern of patterns) {
        let p = pattern
        
        // 处理目录模式（以 / 结尾）
        const isDirPattern = p.endsWith('/')
        if (isDirPattern) {
            p = p.slice(0, -1)
            if (!isDirectory) {
                continue
            }
        }
        
        // 处理以 / 开头的绝对路径模式
        const isAbsolute = p.startsWith('/')
        if (isAbsolute) {
            p = p.slice(1)
        }
        
        // 简单的模式匹配
        if (p.includes('*')) {
            // 通配符模式：gitignore 语义——* 不跨目录段、** 跨任意段且 **/ 零段可选
            const regex = new RegExp('^' + globPatternToRegExp(p) + '$')
            if (regex.test(baseName) || regex.test(relativePath.replace(/\\/g, '/'))) {
                return true
            }
        } else {
            // 精确匹配
            if (baseName === p || relativePath === p || relativePath.startsWith(p + '/')) {
                return true
            }
            // 检查路径中是否包含该目录
            if (relativePath.includes('/' + p + '/') || relativePath.startsWith(p + '/')) {
                return true
            }
        }
    }
    
    return false
}

/**
 * 文件树节点
 */
interface FileTreeNode {
    name: string
    path: string
    isDirectory: boolean
    children?: FileTreeNode[]
}

/**
 * 递归获取文件树
 */
function buildFileTree(
    dirPath: string,
    rootPath: string,
    patterns: string[],
    depth: number = 0,
    maxDepth: number = 2,
    customIgnorePatterns: string[] = []
): FileTreeNode[] {
    if (depth > maxDepth) {
        return []
    }
    
    const nodes: FileTreeNode[] = []
    
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
            
            if (shouldIgnore(relativePath, patterns, entry.isDirectory(), customIgnorePatterns)) {
                continue
            }
            
            const node: FileTreeNode = {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory()
            }
            
            if (entry.isDirectory()) {
                const children = buildFileTree(fullPath, rootPath, patterns, depth + 1, maxDepth, customIgnorePatterns)
                if (children.length > 0) {
                    node.children = children
                }
            }
            
            nodes.push(node)
        }
        
        // 排序：目录在前，文件在后，按名称排序
        nodes.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) {
                return -1
            }
            if (!a.isDirectory && b.isDirectory) {
                return 1
            }
            return a.name.localeCompare(b.name)
        })
        
    } catch (error) {
        console.error(`[fileTree] Error reading directory ${dirPath}:`, error)
    }
    
    return nodes
}

/**
 * 将文件树转换为层级字符串
 * 一行一个文件或最内部文件夹
 */
function treeToLines(nodes: FileTreeNode[], prefix: string = ''): string[] {
    const lines: string[] = []
    
    for (const node of nodes) {
        if (node.isDirectory) {
            if (node.children && node.children.length > 0) {
                // 有子节点的目录，显示目录名并递归
                lines.push(`${prefix}${node.name}/`)
                lines.push(...treeToLines(node.children, prefix + '  '))
            } else {
                // 空目录（最内部文件夹）
                lines.push(`${prefix}${node.name}/`)
            }
        } else {
            // 文件
            lines.push(`${prefix}${node.name}`)
        }
    }
    
    return lines
}

/**
 * 获取单个工作区的文件目录结构
 * @param workspacePath 工作区路径
 * @param maxDepth 最大深度
 * @param customIgnorePatterns 自定义忽略模式
 * @returns 文件列表字符串，一行一个
 */
function getSingleWorkspaceFileTree(workspacePath: string, maxDepth: number = 2, customIgnorePatterns: string[] = []): string {
    // 解析 .gitignore
    const gitignorePath = path.join(workspacePath, '.gitignore')
    const patterns = parseGitignore(gitignorePath)
    
    // 构建文件树
    const tree = buildFileTree(workspacePath, workspacePath, patterns, 0, maxDepth, customIgnorePatterns)
    
    // 转换为行列表
    const lines = treeToLines(tree)
    
    return lines.join('\n')
}

/**
 * 获取工作区文件目录结构（支持多工作区）
 * @param maxDepth 最大深度
 * @param customIgnorePatterns 自定义忽略模式
 * @returns 文件列表字符串，一行一个
 */
export function getWorkspaceFileTree(maxDepth: number = 2, customIgnorePatterns: string[] = []): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return ''
    }
    
    // 单工作区模式
    if (workspaceFolders.length === 1) {
        return getSingleWorkspaceFileTree(workspaceFolders[0].uri.fsPath, maxDepth, customIgnorePatterns)
    }
    
    // 多工作区模式
    const sections: string[] = []
    
    for (const folder of workspaceFolders) {
        const workspaceName = folder.name
        const workspacePath = folder.uri.fsPath
        const fileTree = getSingleWorkspaceFileTree(workspacePath, maxDepth, customIgnorePatterns)
        
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

/**
 * 获取多工作区描述
 */
export function getWorkspacesDescription(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return 'No workspace open'
    }
    
    if (workspaceFolders.length === 1) {
        return workspaceFolders[0].uri.fsPath
    }
    
    // Multi-root workspace
    const lines = ['Multi-root Workspace:']
    for (const folder of workspaceFolders) {
        lines.push(`- ${folder.name}: ${folder.uri.fsPath}`)
    }
    return lines.join('\n')
}