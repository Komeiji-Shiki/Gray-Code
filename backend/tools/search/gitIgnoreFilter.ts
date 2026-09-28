import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export type DirectoryEntryFilter = (name: string, directory: boolean) => boolean;
interface IgnoreScope { directory: string; matcher: Ignore }
interface DirectoryRules { scopes: IgnoreScope[]; ignored: boolean }

/** 每次查询独享缓存；按目录加载规则，逐条目只做同步匹配，不改变遍历顺序。 */
export function createGitIgnoreFilter(root: string, read: (file: string) => Promise<string | undefined>, caseInsensitive = process.platform === 'win32') {
  const cache = new Map<string, Promise<DirectoryRules>>();
  const test = (scopes: IgnoreScope[], file: string, directory: boolean) => {
    let ignored = false;
    for (const scope of scopes) {
      const relative = path.relative(scope.directory, file).split('\\').join('/');
      if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) continue;
      const result = scope.matcher.test(relative + (directory ? '/' : ''));
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
  const rules = (directory: string): Promise<DirectoryRules> => {
    const cached = cache.get(directory);
    if (cached) return cached;
    const pending = (async () => {
      const relative = path.relative(root, directory);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Ignore scope is outside the search workspace.');
      const parent = relative ? await rules(path.dirname(directory)) : { scopes: [], ignored: false };
      // 被忽略目录内的否定规则不能重新纳入其子文件；显式搜索该目录也遵循同一规则。
      if (parent.ignored || relative && test(parent.scopes, directory, true)) return { scopes: parent.scopes, ignored: true };
      const content = await read(path.join(directory, '.gitignore'));
      return { scopes: content ? [...parent.scopes, { directory, matcher: ignore({ ignorecase: caseInsensitive }).add(content) }] : parent.scopes, ignored: false };
    })();
    cache.set(directory, pending);
    return pending;
  };
  return async (directory: string): Promise<DirectoryEntryFilter | null> => {
    const current = await rules(directory);
    return current.ignored ? null : (name, isDirectory) => test(current.scopes, path.join(directory, name), isDirectory);
  };
}
