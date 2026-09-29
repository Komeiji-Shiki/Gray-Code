/** 失败后由下一次渲染触发重试；冷却期间保留原文，不创建循环定时器。 */
export function lazyDependency<T>(load: () => Promise<T>, changed: () => void, report: (error: unknown) => void) {
  let value: T | undefined;
  let pending: Promise<void> | undefined;
  let retryAt = 0;
  return () => {
    if (value === undefined && !pending && Date.now() >= retryAt) {
      pending = load().then(result => { value = result; changed(); }).catch(error => {
        retryAt = Date.now() + 1000;
        report(error);
      }).finally(() => { pending = undefined; });
    }
    return value;
  };
}
