import { runInNewContext } from 'node:vm';
import { prepareHostPayload } from '../../../shared/hostPayload';

/** 用登记表模拟 Vue 代理：代理对象与原始对象分离，toRaw 只认登记过的代理。 */
function proxies() {
  const raws = new WeakMap<object, object>();
  return {
    wrap<T extends object>(raw: T): T { const proxy = new Proxy(raw, {}); raws.set(proxy, raw); return proxy; },
    toRaw: (value: object) => raws.get(value) ?? value,
  };
}

describe('prepareHostPayload', () => {
  test('另一个窗口创建的普通对象中嵌套的代理也会被解开', () => {
    const { wrap, toRaw } = proxies();
    const output = { longReplies: 'forward' };
    // 外层页面经隔离桥返回的设置：原型属于另一个领域。
    const settings = runInNewContext('({ onebot: { endpoint: "ws://127.0.0.1:3001" } })') as { onebot: Record<string, unknown> };
    expect(Object.getPrototypeOf(settings)).not.toBe(Object.prototype);
    // 组件展开响应式对象后，子对象以代理形式写回原始设置。
    settings.onebot.defaultProfile = { output: wrap(output), autoSummary: { enabled: true } };
    const payload = prepareHostPayload({ settings: wrap(settings) }, toRaw);
    const profile = (payload.settings.onebot.defaultProfile as { output: object });
    expect(profile.output).not.toBe(wrap(output));
    expect(toRaw(profile.output)).toBe(profile.output);
    expect(profile.output).toEqual(output);
    expect(() => structuredClone(payload)).not.toThrow();
    // 原始设置不被改写，未变化的分支仍复用原对象。
    expect(toRaw(settings.onebot.defaultProfile as object)).toBe(settings.onebot.defaultProfile);
  });

  test('类实例保持原样，不展开其内部字段', () => {
    const { toRaw } = proxies();
    const date = new Date(0);
    class Marker { value = 1; }
    const marker = new Marker();
    const payload = prepareHostPayload({ date, marker }, toRaw);
    expect(payload.date).toBe(date);
    expect(payload.marker).toBe(marker);
  });
});
