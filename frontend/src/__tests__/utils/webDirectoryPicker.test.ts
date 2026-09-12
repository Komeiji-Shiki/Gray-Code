import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browseDirectory, finishDirectory, webUi } from '../../../../apps/client/src/webBridge'

const response = (directory: string) => ({ ok: true, status: 200, json: async () => ({ result: {
  directory, parent: '/', directories: [], device: { name: '部署电脑' }, roots: [{ name: '/', path: '/' }],
  breadcrumbs: [{ name: directory, path: directory }]
} }) })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Web 电脑目录选择', () => {
  beforeEach(() => { finishDirectory(false); webUi.directory = ''; webUi.directoryError = ''; webUi.chooserOpen = true })
  afterEach(() => { finishDirectory(false); vi.unstubAllGlobals() })

  it('忽略晚到的旧目录结果，保留用户最后打开的目录', async () => {
    const older = deferred<ReturnType<typeof response>>()
    const newer = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise))
    const first = browseDirectory('/older'), second = browseDirectory('/newer')
    newer.resolve(response('/newer')); await second
    older.resolve(response('/older')); await first
    expect(webUi.directory).toBe('/newer')
    expect(webUi.directoryBreadcrumbs[0].path).toBe('/newer')
    expect(webUi.directoryBusy).toBe(false)
  })

  it('关闭窗口后旧请求不再改变下一次打开的目录', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(response('/selected')))
    const old = browseDirectory('/old')
    finishDirectory(false); webUi.chooserOpen = true
    await browseDirectory('/selected')
    pending.resolve(response('/old')); await old
    expect(webUi.directory).toBe('/selected')
    webUi.directoryError = '目录不存在'
    finishDirectory(true)
    expect(webUi.chooserOpen).toBe(true)
  })
})
