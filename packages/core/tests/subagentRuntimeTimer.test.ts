import { SubagentRuntimeTimer } from '../../../apps/server/src/subagents/runtimeTimer';

describe('子代理运行时长', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('只累计实际运行，暂停后继续使用剩余时长并只触发一次', () => {
    const expire = jest.fn();
    const timer = new SubagentRuntimeTimer(40, expire);
    jest.advanceTimersByTime(15_000);
    timer.pause(); timer.pause();
    jest.advanceTimersByTime(120_000);
    expect(expire).not.toHaveBeenCalled();
    timer.resume(); timer.resume();
    jest.advanceTimersByTime(24_999);
    expect(expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(expire).toHaveBeenCalledTimes(1);
    timer.resume();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('超过单个定时器上限也不会立即超时', () => {
    const expire = jest.fn();
    const timer = new SubagentRuntimeTimer(3_000_000, expire);
    jest.advanceTimersByTime(2_147_483_647);
    expect(expire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3_000_000_000 - 2_147_483_647);
    expect(expire).toHaveBeenCalledTimes(1);
    timer.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('无限制不创建定时器，结束后恢复也不会重新计时', () => {
    const unlimited = new SubagentRuntimeTimer(-1, jest.fn());
    expect(jest.getTimerCount()).toBe(0);
    unlimited.pause(); unlimited.resume(); unlimited.dispose();
    const expire = jest.fn();
    const timer = new SubagentRuntimeTimer(1, expire);
    timer.pause(); timer.dispose(); timer.resume();
    jest.advanceTimersByTime(2_000);
    expect(expire).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
