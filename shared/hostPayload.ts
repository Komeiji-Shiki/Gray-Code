/** 解除宿主请求中的 Vue 代理；值的支持范围与序列化语义由正式传输决定。 */
export function prepareHostPayload<T>(value: T, toRaw: (value: object) => object): T {
  interface PayloadNode {
    raw: object;
    parents: Set<PayloadNode>;
    copy?: object;
  }
  const visited = new WeakMap<object, PayloadNode>();
  const changed: PayloadNode[] = [];
  const copyNode = (node: PayloadNode): void => {
    if (node.copy) return;
    node.copy = Array.isArray(node.raw) ? new Array(node.raw.length) : Object.create(Object.getPrototypeOf(node.raw));
    changed.push(node);
  };
  const visit = (input: unknown, parent?: PayloadNode): unknown => {
    if (input === null || typeof input !== 'object') return input;
    const raw = toRaw(input);
    const prototype = Object.getPrototypeOf(raw);
    // 桌面设置由外层页面经隔离桥返回，原型是另一个窗口的 Object.prototype；按原型链判断普通对象，才能继续解开其中嵌套的代理。
    if (!Array.isArray(raw) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      if (parent && raw !== input) copyNode(parent);
      return raw;
    }

    let node = visited.get(raw);
    const known = node !== undefined;
    if (!node) {
      node = { raw, parents: new Set() };
      visited.set(raw, node);
    }
    if (parent) node.parents.add(parent);
    if (raw !== input) copyNode(node);
    if (!known) {
      for (const key of Object.keys(raw)) visit((raw as Record<string, unknown>)[key], node);
    }
    return raw;
  };
  const raw = visit(value);
  // 先收集完整父引用，再传播变化；循环中的代理即使较晚出现，也能更新所有引用它的分支。
  for (let index = 0; index < changed.length; index++) {
    for (const parent of changed[index].parents) copyNode(parent);
  }
  const resolve = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input;
    const original = toRaw(input);
    return visited.get(original)?.copy ?? original;
  };
  // 所有需要的副本已经分配，直接连接共享引用和循环；未变化的对象从未创建数据副本。
  for (const node of changed) {
    for (const key of Object.keys(node.raw)) {
      const item = resolve((node.raw as Record<string, unknown>)[key]);
      Object.defineProperty(node.copy, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
  }
  return resolve(raw) as T;
}
