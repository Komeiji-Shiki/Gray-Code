import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { workspace } from '../__mocks__/vscode'
import {
    FILE_TREE_MAX_NODES,
    getIgnoreRegexCacheStats,
    getWorkspaceFileTree
} from '../../modules/prompt/fileTree'

describe('fileTree buildFileTree', () => {
    let root: string
    let originalFolders: any

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-filetree-test-'))
        originalFolders = workspace.workspaceFolders
        workspace.workspaceFolders = [{
            name: 'ws',
            uri: { fsPath: root, toString: () => 'file://' + root.replace(/\\/g, '/') }
        }] as any
    })

    afterEach(() => {
        workspace.workspaceFolders = originalFolders
        fs.rmSync(root, { recursive: true, force: true })
    })

    function write(rel: string, content: string = ''): void {
        const p = path.join(root, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, content)
    }

    it('截断：节点数量预算耗尽时截断文件树并标记 truncated', () => {
        for (let i = 0; i < 8; i++) {
            write(`f${i}.txt`, `content ${i}`)
        }

        const budget = 5
        const tree = getWorkspaceFileTree(10, [], budget)
        const lines = tree.split('\n').filter(l => l.length > 0)

        // 5 个节点 + 1 行截断标记
        expect(lines).toHaveLength(budget + 1)
        expect(lines[lines.length - 1]).toContain(`file tree truncated: exceeded ${budget} nodes`)
        // 默认预算（FILE_TREE_MAX_NODES）不截断
        expect(getWorkspaceFileTree(10)).toContain('f7.txt')
        expect(getWorkspaceFileTree(10)).not.toContain('truncated')
        expect(FILE_TREE_MAX_NODES).toBeGreaterThan(0)
    })

    it('! 否定：.gitignore 的 !keep.log 重新包含被排除的文件', () => {
        write('.gitignore', '*.log\n!keep.log\n')
        write('a.log', 'a')
        write('keep.log', 'keep')
        write('other.txt', 'other')

        const tree = getWorkspaceFileTree(10)

        expect(tree).toContain('keep.log')
        expect(tree).not.toContain('a.log')
        expect(tree).toContain('other.txt')
    })

    it('! 否定：被排除目录下的文件不能被重新包含（git 语义）', () => {
        write('.gitignore', 'build/\n!build/keep.txt\n')
        write('build/keep.txt', 'x')
        write('src/main.txt', 'y')

        const tree = getWorkspaceFileTree(10)

        expect(tree).not.toContain('build/')
        expect(tree).not.toContain('keep.txt')
        expect(tree).toContain('main.txt')
    })

    it('正则缓存复用：相同模式第二次调用零编译、有命中', () => {
        write('.gitignore', '*.zz1\n*.zz2\n')
        write('a.zz1', 'a')
        write('b.zz2', 'b')
        write('c.txt', 'c')
        // 使用此前测试未出现过的全新模式，保证编译数可精确断言
        const customPatterns = ['*.zz3', '*.zz4']

        const before = getIgnoreRegexCacheStats()
        getWorkspaceFileTree(10, customPatterns)
        const afterFirst = getIgnoreRegexCacheStats()
        // 文件树结果缓存（TTL 内同参数零磁盘 I/O）会短路第二次同参数调用、不触发任何
        // shouldIgnore 求值——改用不同 maxDepth 绕过结果缓存，让正则缓存路径真正被执行
        getWorkspaceFileTree(11, customPatterns)
        const afterSecond = getIgnoreRegexCacheStats()

        // 第一次调用完成全部编译（gitignore 2 条 + 自定义 2 条）
        expect(afterFirst.compiles - before.compiles).toBe(4)
        // 第二次调用零编译、有命中
        expect(afterSecond.compiles).toBe(afterFirst.compiles)
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
    })
})
