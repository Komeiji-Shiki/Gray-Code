import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 沿安装时的模块查找路径收集依赖，保留嵌套版本和工作区包的实际位置。 */
export function collectRuntimeDependencies(root, names) {
  const modules = path.join(root, 'node_modules');
  const packages = new Map();
  const queue = names.map(name => ({ name, from: root }));
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  while (queue.length) {
    const { name, from, optional = false } = queue.shift();
    const search = createRequire(path.join(from, 'package.json')).resolve.paths(name) ?? [];
    const base = search.find(directory => fs.existsSync(path.join(directory, name, 'package.json')));
    if (!base) {
      if (optional) continue;
      throw new Error(`桌面运行时依赖未安装：${name}（依赖方：${from}）。请先执行 npm install。`);
    }
    const installed = path.join(base, name);
    let relative;
    if (inside(modules, installed)) relative = path.relative(root, installed);
    else {
      // 工作区符号链接的本地依赖须映射到该包在发布目录中的位置。
      const parent = [...packages.values()].filter(item => inside(item.dir, installed))
        .sort((left, right) => right.dir.length - left.dir.length)[0];
      if (!parent) throw new Error(`运行时依赖位于已收集包之外：${installed}`);
      relative = path.join(parent.relative, path.relative(parent.dir, installed));
    }
    if (packages.has(relative)) continue;
    const dir = fs.realpathSync(installed);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const entry = { name, dir, relative, version: manifest.version ?? '0.0.0' };
    packages.set(relative, entry);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      queue.push({ name: dependency, from: dir, optional: Object.hasOwn(manifest.optionalDependencies ?? {}, dependency) });
    }
  }
  return packages;
}
