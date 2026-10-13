/** 解除宿主请求中的 Vue 代理；值的支持范围与序列化语义由正式传输决定。 */
export function prepareHostPayload<T>(value: T, toRaw: (value: object) => object): T {
  const visited = new WeakMap<object, object>();
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    const raw = toRaw(input);
    const previous = visited.get(raw);
    if (previous) return previous;
    const array = Array.isArray(raw);
    const prototype = Object.getPrototypeOf(raw);
    if (!array && prototype !== Object.prototype && prototype !== null) return raw;

    const copy: object = array ? new Array((raw as unknown[]).length) : Object.create(prototype);
    // 提前登记，保持共享引用和结构化克隆支持的循环关系。
    visited.set(raw, copy);
    let changed = raw !== input;
    for (const key of Object.keys(raw)) {
      const original = (raw as Record<string, unknown>)[key];
      const item = visit(original);
      Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
      changed ||= !Object.is(item, original);
    }
    const result = changed ? copy : raw;
    visited.set(raw, result);
    return result;
  };
  return visit(value) as T;
}
