import fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { clearGlobalContext, setGlobalSettingsManager } from '../../core/settingsContext'
import {
    getGlobIgnoreRegexCacheStats,
    PINNED_FILE_CACHE_TTL_MS,
    PINNED_FILE_MAX_BYTES,
    PINNED_FILE_MAX_TOTAL_BYTES,
    PromptManager
} from '../../modules/prompt/PromptManager'
import { TabInputText, window, workspace } from '../__mocks__/vscode'
import type { ResolvedPromptModeSnapshot } from '../../modules/settings/types'

const pinnedMode: ResolvedPromptModeSnapshot = {
    id: 'pinned',
    name: 'Pinned',
    template: '',
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: '{{$PINNED_FILES}}',
    promptEntries: []
}

function createSettingsManagerMock(pinnedFiles: any[]) {
    const config = {
        customPrefix: '',
        customSuffix: '',
        dynamicTemplateEnabled: true,
        dynamicTemplate: '',
        dynamicContextStrategy: 'single',
        template: '',
        currentModeId: pinnedMode.id,
        modes: { [pinnedMode.id]: pinnedMode }
    };
    return {
        resolvePromptMode: jest.fn(() => pinnedMode),
        getSystemPromptConfig: jest.fn(() => config),
        getContextAwarenessConfig: jest.fn(() => ({
            includeWorkspaceFiles: false,
            includeOpenTabs: false,
            includeActiveEditor: false,
            ignorePatterns: []
        })),
        getPinnedFilesConfig: jest.fn(() => ({ sectionTitle: 'PINNED FILES CONTENT' })),
        getEnabledPinnedFiles: jest.fn(() => pinnedFiles),
        getUISettings: jest.fn(() => ({ language: 'zh-CN' })),
        getToolsConfig: jest.fn(() => ({}))
    } as any;
}

describe('PromptManager generatePinnedFilesSection（热路径性能修复）', () => {
    let root: string
    let originalFolders: any
    let originalTabs: any
    let originalGetFolder: any
    let originalAsRelative: any

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-pinned-test-'))
        originalFolders = workspace.workspaceFolders
        originalTabs = window.tabGroups.all
        originalGetFolder = workspace.getWorkspaceFolder
        originalAsRelative = workspace.asRelativePath
        workspace.workspaceFolders = [{
            name: 'ws',
            uri: { fsPath: root, toString: () => 'file://' + root.replace(/\\/g, '/') }
        }] as any
    })

    afterEach(() => {
        workspace.workspaceFolders = originalFolders
        window.tabGroups.all = originalTabs
        workspace.getWorkspaceFolder = originalGetFolder
        workspace.asRelativePath = originalAsRelative
        jest.restoreAllMocks()
        jest.useRealTimers()
        clearGlobalContext()
        fs.rmSync(root, { recursive: true, force: true })
    })

    function pinnedFile(rel: string): any {
        return {
            id: rel,
            path: rel,
            workspaceUri: 'file://' + root.replace(/\\/g, '/'),
            enabled: true,
            addedAt: 0
        }
    }

    it('单文件超过字节上限时截断并标记 truncated（不读入整文件）', () => {
        fs.writeFileSync(
            path.join(root, 'big.txt'),
            'A'.repeat(PINNED_FILE_MAX_BYTES + 2000) + 'TAIL_SENTINEL'
        )
        setGlobalSettingsManager(createSettingsManagerMock([pinnedFile('big.txt')]))
        const manager = new PromptManager({ includeWorkspaceFiles: false })

        const text = manager.getPromptContextBundle(pinnedMode).text

        expect(text).toContain('--- big.txt ---')
        expect(text).toContain(`[truncated: file exceeds ${PINNED_FILE_MAX_BYTES} bytes]`)
        expect(text).not.toContain('TAIL_SENTINEL')
        // 截断后正文 + 标记的总长远小于原文件大小
        expect(text.length).toBeLessThan(PINNED_FILE_MAX_BYTES + 1024)
    })

    it('累计读取超过总字节预算时跳过剩余固定文件', () => {
        const chunk = 'B'.repeat(PINNED_FILE_MAX_BYTES + 100)
        fs.writeFileSync(path.join(root, 'one.txt'), chunk)
        fs.writeFileSync(path.join(root, 'two.txt'), chunk)
        fs.writeFileSync(path.join(root, 'three.txt'), chunk)
        setGlobalSettingsManager(createSettingsManagerMock([
            pinnedFile('one.txt'),
            pinnedFile('two.txt'),
            pinnedFile('three.txt')
        ]))
        const manager = new PromptManager({ includeWorkspaceFiles: false })

        const text = manager.getPromptContextBundle(pinnedMode).text

        // 前两个文件各 1MB 刚好占满 2MB 预算，第三个被跳过
        expect(text).toContain('--- one.txt ---')
        expect(text).toContain('--- two.txt ---')
        expect(text).not.toContain('--- three.txt ---')
        expect(PINNED_FILE_MAX_TOTAL_BYTES).toBe(PINNED_FILE_MAX_BYTES * 2)
    })

    it('TTL 内复用缓存零磁盘读；mtime 变更后越过 TTL 才重读', () => {
        jest.useFakeTimers()
        const file = path.join(root, 'cache.txt')
        fs.writeFileSync(file, 'version-1')
        setGlobalSettingsManager(createSettingsManagerMock([pinnedFile('cache.txt')]))
        const manager = new PromptManager({ includeWorkspaceFiles: false })

        const readSpy = jest.spyOn(fs, 'readFileSync')
        const statSpy = jest.spyOn(fs, 'statSync')

        const first = manager.getPromptContextBundle(pinnedMode).text
        expect(first).toContain('version-1')
        expect(readSpy).toHaveBeenCalledTimes(1)
        const statCallsAfterFirst = statSpy.mock.calls.length

        // TTL 内修改文件：仍返回缓存内容，不 stat、不读盘
        fs.writeFileSync(file, 'version-2-changed')
        // 强制把 mtime 推到未来，保证与首次读取时的 mtime 不同（无需测试内 statSync）
        fs.utimesSync(file, new Date(Date.now() + 100000), new Date(Date.now() + 100000))
        const second = manager.getPromptContextBundle(pinnedMode).text
        expect(second).toContain('version-1')
        expect(readSpy).toHaveBeenCalledTimes(1)
        expect(statSpy.mock.calls.length).toBe(statCallsAfterFirst)

        // 越过 TTL：stat 校验发现 mtime 变更 → 重读
        jest.advanceTimersByTime(PINNED_FILE_CACHE_TTL_MS + 1000)
        const third = manager.getPromptContextBundle(pinnedMode).text
        expect(third).toContain('version-2-changed')
        expect(readSpy).toHaveBeenCalledTimes(2)

        // 再次越过 TTL 但文件未变更：stat 后复用缓存，不重读
        const readsBefore = readSpy.mock.calls.length
        jest.advanceTimersByTime(PINNED_FILE_CACHE_TTL_MS + 1000)
        const fourth = manager.getPromptContextBundle(pinnedMode).text
        expect(fourth).toContain('version-2-changed')
        expect(readSpy).toHaveBeenCalledTimes(readsBefore)
    })

    it('忽略模式正则按模式缓存复用（第二次生成零编译）', () => {
        workspace.getWorkspaceFolder = jest.fn(() => workspace.workspaceFolders?.[0])
        workspace.asRelativePath = jest.fn((uri: any) => {
            const parts = String(uri?.path ?? uri?.fsPath ?? '').split('/')
            return parts[parts.length - 1] || 'unknown'
        })
        window.tabGroups.all = [{
            tabs: [
                { input: new TabInputText({ path: '/ws/src/a.ts' }) },
                { input: new TabInputText({ path: '/ws/src/b.js' }) },
                { input: new TabInputText({ path: '/ws/README.md' }) }
            ]
        }] as any

        const tabsMode: ResolvedPromptModeSnapshot = {
            ...pinnedMode,
            id: 'tabs',
            dynamicTemplate: '{{$OPEN_TABS}}'
        }
        const settingsMock = createSettingsManagerMock([])
        settingsMock.getContextAwarenessConfig = jest.fn(() => ({
            includeWorkspaceFiles: false,
            includeOpenTabs: true,
            maxOpenTabs: 10,
            includeActiveEditor: false,
            ignorePatterns: ['*.ts', '*.js']
        }))
        setGlobalSettingsManager(settingsMock)
        const manager = new PromptManager({ includeWorkspaceFiles: false })

        const before = getGlobIgnoreRegexCacheStats()
        const first = manager.getPromptContextBundle(tabsMode).text
        const afterFirst = getGlobIgnoreRegexCacheStats()
        const second = manager.getPromptContextBundle(tabsMode).text
        const afterSecond = getGlobIgnoreRegexCacheStats()

        // 匹配逻辑生效：README.md 保留，a.ts / b.js 被忽略模式排除
        expect(first).toContain('README.md')
        expect(first).not.toContain('a.ts')
        expect(first).not.toContain('b.js')
        // 第一次调用编译 2 个模式（*.ts、*.js）
        expect(afterFirst.compiles - before.compiles).toBe(2)
        // 第二次调用零编译、有命中
        expect(afterSecond.compiles).toBe(afterFirst.compiles)
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
        expect(second).toContain('README.md')
    })
})
