/**
 * 工作区 glob 遍历器（Node 宿主专用，readdir 可注入以便测试）。
 *
 * 修改原因：find_files / search_in_files / 工作区搜索共用的 NodeFileHost 目录遍历
 * 原先对每个目录条目执行 1-2 次 minimatch、对每个子目录做一次 realpath，且单个
 * 目录读取失败会中断整个查找。大工作区实测（约 1.6 万目录 / 6 万条目）：全树遍历
 * 约 3s，其中大部分时间花在逐条目 glob 匹配上；临时目录消失（ENOENT）会让整个
 * 查找直接失败。
 * 修改方式：
 *   1. 默认排除模式（整组都是 `**\/name\/**` 形式）与常见包含模式（`**\/*`、
 *      `**\/*.ext`、`*.ext`）改走字面量快速路径，其余模式保持 minimatch 回退，
 *      语义与旧实现完全一致（含 nocase/dot 选项）；
 *   2. 相对路径沿父目录拼接，不再对每个条目做 path.relative + 分隔符归一化；
 *   3. 只要求调用方先解析（realpath）根目录；子目录沿已解析根的条目名拼接，且
 *      遍历跳过符号链接与目录联动点，因此不可能跨出根目录；
 *   4. 子目录读取失败时跳过（可选回调上报），根目录失败仍然抛出。
 * 修改目的：在结果与顺序完全不变的前提下把遍历成本降到接近纯 readdir；单个坏目录
 * 不再破坏整个查找。
 */
import minimatch from 'minimatch';
import * as path from 'node:path';

export interface GlobWalkerDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface GlobWalkerMatch {
  absolute: string;
  relative: string;
}

export interface GlobWalkerOptions {
  /** 已解析（realpath）过的绝对根目录 */
  root: string;
  pattern: string;
  /** 组合后的排除模式（`{a,b}` 或单条）；空值表示不排除 */
  exclude?: string;
  /** 最多返回多少个匹配文件 */
  limit: number;
  readdir: (absolute: string) => Promise<GlobWalkerDirent[]>;
  /** 绝对路径拼接；默认 path.join */
  joinPath?: (directory: string, name: string) => string;
  /** 大小写不敏感匹配；默认跟随平台（win32 不敏感） */
  caseInsensitive?: boolean;
  throwIfAborted?: () => void;
  /** 子目录读取失败时回调（默认静默跳过） */
  onDirectoryError?: (absolute: string, error: unknown) => void;
}

function normalizeName(name: string, caseInsensitive: boolean): string {
  return caseInsensitive ? name.toLowerCase() : name;
}

/**
 * 尝试把包含模式编译成"后缀匹配"快速路径。
 *
 * 支持：`**\/*`（全部文件）、`**\/*.ext`、`*.ext`（后缀链，如 `.d.ts`，不含 glob
 * 元字符）。返回 null 表示需要回退 minimatch。
 *
 * 语义等价依据（minimatch, dot:true）：
 * - `**\/*.ext` 等价于"最后一段以 .ext 结尾"（`*` 不跨 `/`，`**\/` 可匹配任意前缀）；
 * - `*.ext` 只匹配根层级（不含 `/`）；
 * - nocase 时对两侧统一做小写比较。
 */
export function tryCreateIncludeFastPath(
  pattern: string,
  caseInsensitive: boolean
): ((relative: string) => boolean) | null {
  if (pattern === '**/*') {
    return () => true;
  }

  // 后缀链：.ts、.d.ts、.min.js …… 每段以 "." 开头且不含 glob 元字符；
  // '**/*.ext' 的文件名部分是 '*' + 后缀链，'*.ext' 是根层级同形。
  const suffixGroup = '(?:\\.[^./\\\\*?\\[\\]{}()!+@\\s]+)+';
  const anyDepth = new RegExp(`^\\*\\*\\/\\*(${suffixGroup})$`).exec(pattern);
  if (anyDepth) {
    const suffix = caseInsensitive ? anyDepth[1].toLowerCase() : anyDepth[1];
    return caseInsensitive
      ? relative => relative.toLowerCase().endsWith(suffix)
      : relative => relative.endsWith(suffix);
  }
  const rootOnly = new RegExp(`^\\*(${suffixGroup})$`).exec(pattern);
  if (rootOnly) {
    const suffix = caseInsensitive ? rootOnly[1].toLowerCase() : rootOnly[1];
    return caseInsensitive
      ? relative => !relative.includes('/') && relative.toLowerCase().endsWith(suffix)
      : relative => !relative.includes('/') && relative.endsWith(suffix);
  }
  return null;
}

/**
 * 尝试把排除模式解析成"按目录名字面量跳过"的集合。
 *
 * 仅当整组模式都是 `**\/name\/**` 且 name 不含 glob 元字符、逗号与空白时返回
 * Set；否则返回 null（回退 minimatch）。
 *
 * 语义等价依据：`**\/name\/**` 只可能匹配"路径中存在 name 目录段且其后还有内容"
 * 的条目（目录判断时旧实现用 `relative + '/'` 匹配）。在任意深度跳过名为 name 的
 * 目录与逐条目匹配的结果一致；文件路径不含 name 之后的目录段，不会单独命中该模式。
 */
export function tryParseLiteralDirectoryExcludes(
  exclude: string | undefined,
  caseInsensitive: boolean
): Set<string> | null {
  if (!exclude) {
    return null;
  }
  const parts = exclude.startsWith('{') && exclude.endsWith('}')
    ? exclude.slice(1, -1).split(',')
    : [exclude];
  if (parts.length === 0) {
    return null;
  }

  const names = new Set<string>();
  for (const part of parts) {
    const segments = part.split('/');
    if (segments.length !== 3 || segments[0] !== '**' || segments[2] !== '**') {
      return null;
    }
    const name = segments[1];
    if (!name || !/^[^/\\*?[\]{}()!+@\s,]+$/.test(name)) {
      return null;
    }
    names.add(normalizeName(name, caseInsensitive));
  }
  return names.size > 0 ? names : null;
}

/**
 * 深度优先遍历目录树并产出匹配文件。
 *
 * 遍历顺序与旧实现（NodeFileHost.iterateFiles）完全一致：目录栈 LIFO，目录内条目
 * 按 readdir 顺序处理，匹配文件即产即出。符号链接与 `.git` 目录不进入。
 */
export async function* walkGlobTree(options: GlobWalkerOptions): AsyncGenerator<GlobWalkerMatch> {
  const { root, pattern, exclude, limit, readdir } = options;
  const joinPath = options.joinPath ?? ((directory: string, name: string) => path.join(directory, name));
  const caseInsensitive = options.caseInsensitive ?? process.platform === 'win32';
  const throwIfAborted = options.throwIfAborted ?? (() => { /* 未提供中止检查 */ });
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (boundedLimit <= 0) {
    return;
  }

  const includeFast = tryCreateIncludeFastPath(pattern, caseInsensitive);
  const includeMatcher = new minimatch.Minimatch(pattern, { dot: true, nocase: caseInsensitive });
  const matchInclude = includeFast ?? ((relative: string) => includeMatcher.match(relative));

  const directoryExcludes = tryParseLiteralDirectoryExcludes(exclude, caseInsensitive);
  const ignoredMatcher = directoryExcludes
    ? null
    : new minimatch.Minimatch(exclude || '__graycode_no_exclusions__', { dot: true, nocase: caseInsensitive });

  const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: '' }];
  let found = 0;
  let isRootDirectory = true;

  while (stack.length > 0 && found < boundedLimit) {
    const current = stack.pop()!;
    throwIfAborted();

    const mustSucceed = isRootDirectory;
    isRootDirectory = false;
    let entries: GlobWalkerDirent[];
    try {
      entries = await readdir(current.absolute);
    } catch (error) {
      if (mustSucceed) {
        throw error;
      }
      // 子目录读取失败（ENOENT/EACCES 等）：跳过该子树，不中断整个查找
      options.onDirectoryError?.(current.absolute, error);
      continue;
    }

    for (const entry of entries) {
      throwIfAborted();
      if (entry.isSymbolicLink()) {
        continue;
      }

      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (directoryExcludes) {
          if (directoryExcludes.has(normalizeName(entry.name, caseInsensitive))) {
            continue;
          }
        } else if (ignoredMatcher!.match(relative) || ignoredMatcher!.match(`${relative}/`)) {
          continue;
        }
        if (entry.name !== '.git') {
          stack.push({ absolute: joinPath(current.absolute, entry.name), relative });
        }
      } else if (entry.isFile()) {
        if (!directoryExcludes && ignoredMatcher!.match(relative)) {
          continue;
        }
        if (matchInclude(relative)) {
          found++;
          yield { absolute: joinPath(current.absolute, entry.name), relative };
        }
        if (found >= boundedLimit) {
          break;
        }
      }
    }
  }
}
