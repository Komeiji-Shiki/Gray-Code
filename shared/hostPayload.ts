/**
 * 仅复制响应式代理所在的分支，普通兄弟节点与大字符串继续直接传输。
 * Vue 的实际解包函数由调用端提供，shared 不引入前端运行时。
 */
export function prepareHostPayload<T>(value: T, unwrapProxy: (value: object) => object): T {
  const needsJson = Symbol('host-payload-json');
  let sawProxy = false;
  let jsonChangesPrimitives = false;
  let ancestors: Set<object> | undefined;
  let completed: WeakMap<object, object> | undefined;
  const visit = (input: unknown): unknown => {
    const type = typeof input;
    if (input === null || type !== 'object') {
      if (type === 'function' || type === 'symbol') throw needsJson;
      if (type === 'undefined' || type === 'bigint' || type === 'number' && !Number.isFinite(input)) jsonChangesPrimitives = true;
      return input;
    }
    let raw: object;
    try { raw = unwrapProxy(input as object); }
    catch { throw needsJson; }
    if (raw !== input) {
      // 同名普通数据不能被当作 Vue 的虚拟标记删掉；仍走原来的 JSON 语义。
      if (Object.hasOwn(input as object, '__v_raw')) throw needsJson;
      sawProxy = true;
    }
    const array = Array.isArray(raw);
    const proto = Object.getPrototypeOf(raw);
    if (!array && proto !== Object.prototype && proto !== null) throw needsJson;
    const keys = array ? [] : Object.keys(raw);
    if (!array && keys.length <= 2 && keys.every(key => {
      const item = (raw as Record<string, unknown>)[key];
      return item === null || typeof item !== 'object';
    })) {
      for (const key of keys) visit((raw as Record<string, unknown>)[key]);
      return raw;
    }
    ancestors ??= new Set();
    if (ancestors.has(raw)) throw needsJson;
    const previous = completed?.get(raw);
    if (previous) return previous;
    ancestors.add(raw);
    try {
      let copied: any;
      if (array) {
        const items = raw as unknown[];
        for (let index = 0; index < items.length; index++) {
          const original = items[index];
          const item = visit(original);
          if (!Object.is(item, original)) { copied ??= items.slice(); copied[index] = item; }
        }
      } else {
        const record = raw as Record<string, unknown>;
        for (const key of keys) {
          const original = record[key];
          const item = visit(original);
          if (!Object.is(item, original)) {
            copied ??= Object.setPrototypeOf(Object.fromEntries(keys.map(name => [name, record[name]])), proto);
            copied[key] = item;
          }
        }
      }
      const result = copied ?? raw;
      (completed ??= new WeakMap()).set(raw, result);
      return result;
    } finally { ancestors.delete(raw); }
  };
  try {
    const prepared = visit(value);
    // 原先只要有 Proxy 就对整个根对象 JSON 化；混合 undefined/BigInt/NaN 等时保留这条转换规则。
    return (sawProxy && jsonChangesPrimitives ? JSON.parse(JSON.stringify(value)) : prepared) as T;
  } catch (error) {
    if (error !== needsJson) throw error;
    // Date/Map/函数等非 JSON 数据继续沿用原转换；循环引用仍由 JSON 报错。
    return JSON.parse(JSON.stringify(value));
  }
}
