import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'fs';
import * as path from 'path';

/** Optional media modules are supplied by the host; importing image code never loads VS Code. */
export interface DependencyRuntime {
    getDependencyPath(name: string): string | null;
    load(name: string, entry?: string): Promise<any | null>;
}
// 独立应用按调用作用域选取依赖目录，多个核心实例不会覆盖彼此。
const dependencyScope = new AsyncLocalStorage<DependencyRuntime>();
export function withDependencyRuntime<T>(runtime: DependencyRuntime, action: () => T): T {
    return dependencyScope.run(runtime, action);
}
function currentRuntime(): DependencyRuntime | undefined { return dependencyScope.getStore() ?? resolveRuntime?.(); }
let resolveRuntime: (() => DependencyRuntime) | undefined;
export function setDependencyRuntime(resolver: () => DependencyRuntime): void { resolveRuntime = resolver; }
export function getDependencyPath(name: string): string | null {
    try { return currentRuntime()?.getDependencyPath(name) ?? null; } catch { return null; }
}
export async function getSharp(): Promise<any | null> {
    try { return await currentRuntime()?.load('sharp') ?? null; } catch { return null; }
}
export async function getCanvas(): Promise<any | null> {
    try { return await currentRuntime()?.load('@napi-rs/canvas') ?? null; } catch { return null; }
}
export async function getPdfjs(): Promise<any | null> {
    try {
        const runtime = currentRuntime();
        if (!runtime) return null;
        const directory = runtime.getDependencyPath('pdfjs-dist');
        const entry = 'legacy/build/pdf.mjs';
        if (directory && fs.existsSync(path.join(directory, entry))) {
            const legacy = await runtime.load('pdfjs-dist', entry);
            if (legacy) return legacy;
        }
        return await runtime.load('pdfjs-dist');
    } catch { return null; }
}
