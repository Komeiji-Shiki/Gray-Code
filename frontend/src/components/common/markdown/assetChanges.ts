const subscriptions = new Set<{ paths(): string[]; changed(): void }>();
let requestGeneration = 0;
export const assetRequestGeneration = () => requestGeneration;
const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
export const assetPathMatches = (path: string, changed: string) => {
  const left = normalize(path), right = normalize(changed);
  return left === right || left.startsWith(right + '/');
};
export function observeAssetPaths(paths: () => string[], changed: () => void) {
  const subscription = { paths, changed };
  subscriptions.add(subscription);
  return () => { subscriptions.delete(subscription); };
}
export function notifyAssetChanges(paths?: readonly string[]) {
  requestGeneration++;
  for (const subscription of [...subscriptions]) {
    if (!paths || subscription.paths().some(path => paths.some(changed => assetPathMatches(path, changed)))) subscription.changed();
  }
}
