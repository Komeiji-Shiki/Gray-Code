import { afterEach, expect, test, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { PetRequests } from '../../../../apps/client/src/pets/requests';
import { lazyDependency } from '../../components/common/markdown/lazyDependency';
import { redactDiagnostic } from '../../../../shared/diagnosticText';

afterEach(() => vi.useRealTimers());

test('复制诊断移除授权头、带空格的密钥及 URL 凭据，保留错误原因', () => {
  const result = redactDiagnostic('HTTP 401\nAuthorization: Bearer raw-secret\nCookie: session=raw-session; other=secret\n{"apiKey":"private key value"}\nhttps://name:password@example.test/?token=private-token');
  expect(result).toContain('HTTP 401'); expect(result).toContain('example.test');
  for (const secret of ['raw-secret', 'raw-session', 'private key value', 'name:password', 'private-token']) expect(result).not.toContain(secret);
});

test('桌宠回执及时完成，长动画不被确认超时打断；无回执和取消均释放等待', async () => {
  vi.useFakeTimers();
  const requests = new PetRequests();
  const accepted = requests.wait('long-animation'); requests.settle('long-animation'); await accepted;
  const missing = expect(requests.wait('missing')).rejects.toThrow('实际结果未知');
  await vi.advanceTimersByTimeAsync(5000); await missing;
  const controller = new AbortController();
  const cancelled = expect(requests.wait('cancel', controller.signal)).rejects.toThrow('取消');
  controller.abort(); await cancelled;
  const closed = expect(requests.wait('closed')).rejects.toThrow('关闭');
  requests.rejectAll(new Error('关闭')); await closed;
  expect(vi.getTimerCount()).toBe(0);
});

test('依赖首次失败后等待冷却并在后续渲染恢复，重复读取只发起一次加载', async () => {
  vi.useFakeTimers();
  const renderer = {}, load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(renderer);
  const changed = vi.fn(), report = vi.fn();
  const get = lazyDependency(load, changed, report);
  expect(get()).toBeUndefined(); get(); await flushPromises();
  expect(load).toHaveBeenCalledTimes(1); expect(report).toHaveBeenCalledTimes(1);
  get(); expect(load).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000); get(); await flushPromises();
  expect(get()).toBe(renderer); expect(changed).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(2);
});
