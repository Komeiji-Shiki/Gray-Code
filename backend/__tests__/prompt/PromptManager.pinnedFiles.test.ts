import fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { PINNED_FILE_MAX_BYTES, readPinnedFileCapped } from '../../modules/prompt/pinnedFiles'
import { getGlobIgnoreRegexCacheStats } from '../../modules/prompt/ignorePatterns'
import { formatOpenTabsSection } from '../../modules/prompt/editorSections'
import { TEMP_DIR_REMOVE_OPTIONS } from '../__fixtures__/tempDirectory'

describe('平台固定文件读取与编辑器忽略模式', () => {
    let root: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-pinned-test-'))
    })

    afterEach(() => {
        fs.rmSync(root, TEMP_DIR_REMOVE_OPTIONS)
    })

    test('单文件超过字节上限时截断并标记 truncated（不读入整文件）', () => {
        const file = path.join(root, 'big.txt')
        fs.writeFileSync(file, 'A'.repeat(PINNED_FILE_MAX_BYTES + 512) + 'TAIL_SENTINEL')

        const result = readPinnedFileCapped(file, fs.statSync(file).size)

        expect(result.truncated).toBe(true)
        expect(result.bytesRead).toBe(PINNED_FILE_MAX_BYTES)
        expect(result.content).not.toContain('TAIL_SENTINEL')
        expect(result.content.length).toBe(PINNED_FILE_MAX_BYTES)
    })

    test('忽略模式正则按模式缓存复用（第二次生成零编译）', () => {
        const files = ['a.ts', 'b.js', 'README.md']
        const patterns = ['*.ts', '*.js']
        const before = getGlobIgnoreRegexCacheStats()
        const first = formatOpenTabsSection(files, 10, patterns)
        const afterFirst = getGlobIgnoreRegexCacheStats()
        const second = formatOpenTabsSection(files, 10, patterns)
        const afterSecond = getGlobIgnoreRegexCacheStats()

        expect(first).toContain('README.md')
        expect(first).not.toContain('a.ts')
        expect(first).not.toContain('b.js')
        expect(afterFirst.compiles - before.compiles).toBe(2)
        expect(afterSecond.compiles).toBe(afterFirst.compiles)
        expect(afterSecond.hits).toBeGreaterThan(afterFirst.hits)
        expect(second).toContain('README.md')
    })
})
