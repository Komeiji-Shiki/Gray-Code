import { TerminalOutputBuffer } from '../../../apps/server/src/terminal/output';
import type { TerminalOutputEvent } from '../../../backend/tools/terminal/processRunnerRuntime';

test('终端短输出按帧合并，类型切换、容量阈值和退出均保留完整顺序', () => {
  jest.useFakeTimers();
  const events: TerminalOutputEvent[] = [];
  const output = new TerminalOutputBuffer(event => events.push(event));
  try {
    output.push({ terminalId: 'owned', type: 'start', command: 'fixture' });
    output.push({ terminalId: 'owned', type: 'output', data: '首段🐱' });
    for (let index = 0; index < 1000; index++) output.push({ terminalId: 'owned', type: 'output', data: 'x' });
    expect(events.map(event => event.type)).toEqual(['start', 'output']);
    jest.advanceTimersByTime(16);
    expect(events.at(-1)?.data).toBe('x'.repeat(1000));
    output.push({ terminalId: 'owned', type: 'output', data: '尾部' });
    output.push({ terminalId: 'owned', type: 'error', data: '错误输出' });
    output.push({ terminalId: 'owned', type: 'output', data: 'z'.repeat(20_000) });
    expect(events.at(-1)?.data).toBe('z'.repeat(20_000));
    output.push({ terminalId: 'owned', type: 'exit', exitCode: 7 });
    expect(events.map(event => event.type)).toEqual(['start', 'output', 'output', 'output', 'error', 'output', 'exit']);
    expect(events.filter(event => event.type === 'output').map(event => event.data).join(''))
      .toBe('首段🐱' + 'x'.repeat(1000) + '尾部' + 'z'.repeat(20_000));
    expect(events.find(event => event.type === 'error')?.data).toBe('错误输出');
    expect(events.every(event => event.terminalId === 'owned')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally { output.flush(); jest.useRealTimers(); }
});
