import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WinRtLingerToastAdapter } from '../../modules/notifications/WinRtLingerToastAdapter'

jest.mock('child_process', () => ({
  spawn: jest.fn()
}))
import { spawn } from 'child_process'

const mockSpawn = spawn as jest.Mock

describe('WinRtLingerToastAdapter', () => {
  let tmpExe: string

  beforeEach(() => {
    jest.clearAllMocks()
    mockSpawn.mockImplementation(() => ({
      on: jest.fn(),
      unref: jest.fn()
    }))
    tmpExe = path.join(os.tmpdir(), `test-toast-linger-${Date.now()}-${Math.random().toString(36).slice(2)}.exe`)
    fs.writeFileSync(tmpExe, '')
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpExe) } catch { /* ignore */ }
  })

  test('skips on non-Windows platforms', async () => {
    const adapter = new WinRtLingerToastAdapter(tmpExe, 'linux')
    const result = await adapter.show({ title: 'T', message: 'M', silent: true, waitForAction: false })
    expect(result.shown).toBe(false)
    expect(result.skippedReason).toBe('unsupported_platform')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  test('fails cleanly when toast-linger.exe is missing', async () => {
    const adapter = new WinRtLingerToastAdapter(
      path.join(os.tmpdir(), 'definitely-not-exists.exe'),
      'win32'
    )
    const result = await adapter.show({ title: 'T', message: 'M', silent: true, waitForAction: false })
    expect(result.shown).toBe(false)
    expect(result.error).toContain('toast-linger.exe')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  test('spawns toast-linger with aumid/title/message/linger/silent and returns shown', async () => {
    const adapter = new WinRtLingerToastAdapter(tmpExe, 'win32', 30000, 'GrayCode.Notification')
    const result = await adapter.show({ title: 'Build done', message: 'All tests passed', silent: true, waitForAction: true })
    expect(result.shown).toBe(true)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [exe, args, options] = mockSpawn.mock.calls[0]
    expect(exe).toBe(tmpExe)
    expect(args).toEqual(['GrayCode.Notification', 'Build done', 'All tests passed', '30000', 'true'])
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true })
  })

  test('passes silent=false as false', async () => {
    const adapter = new WinRtLingerToastAdapter(tmpExe, 'win32')
    await adapter.show({ title: 'T', message: 'M', silent: false, waitForAction: false })
    const args = mockSpawn.mock.calls[0][1]
    expect(args[4]).toBe('false')
  })

  test('normalizes over-long title and message', async () => {
    const adapter = new WinRtLingerToastAdapter(tmpExe, 'win32')
    const long = 'x'.repeat(500)
    await adapter.show({ title: long, message: long, silent: true, waitForAction: false })
    const args = mockSpawn.mock.calls[0][1]
    expect(args[1].length).toBeLessThanOrEqual(120)
    expect(args[2].length).toBeLessThanOrEqual(1000)
  })

  test('spawn errors are logged and do not reject', async () => {
    mockSpawn.mockReturnValueOnce({
      on: jest.fn((event: string, cb: (error?: Error) => void) => {
        if (event === 'error') cb(new Error('boom'))
      }),
      unref: jest.fn()
    })
    const adapter = new WinRtLingerToastAdapter(tmpExe, 'win32')
    const result = await adapter.show({ title: 'T', message: 'M', silent: true, waitForAction: false })
    expect(result.shown).toBe(true)
  })
})
