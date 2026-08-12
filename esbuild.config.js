/**
 * GrayCode esbuild bundle 配置
 *
 * 将 extension.ts 打包为 dist/extension.js，替代原有的 tsc 直出方案。
 * node-notifier 等含原生二进制的包使用 copy loader 保留在 dist/node_modules 中。
 *
 * 用法：
 *   node esbuild.config.js              # 单次构建（生产；不带 sourcemap）
 *   node esbuild.config.js --watch      # 监听模式（文件变更自动重新打包；始终带 sourcemap 便于调试）
 *   node esbuild.config.js --sourcemap  # 单次构建并生成 sourcemap（排查线上问题时显式开启）
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// 需要在 node_modules 中保留的包（不能打进 bundle）
// 注意：typescript 仅是 devDependency 且被 .vscodeignore 排除，不能留在 external 里，
// 否则 bundle 中出现 require('typescript') 时用户环境会直接崩溃。
const externalModules = [
    'vscode',
];

// 需要复制 .node 原生文件/资源到 dist/node_modules 的包
// （node-notifier 的 Windows toast 依赖随包分发的 snoretoast.exe 二进制）
const nativePackages = [
    'node-notifier',
];

const outdir = path.join(__dirname, 'dist');
const isWatch = process.argv.includes('--watch');
const withSourcemap = isWatch || process.argv.includes('--sourcemap');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['extension.ts'],
    bundle: true,
    outfile: path.join(outdir, 'extension.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: externalModules.concat(nativePackages),
    // 生产构建不恒定开启 sourcemap（发布产物体积/源码暴露考量）：
    // watch 模式恒开（本地调试依赖源码映射），单次构建需显式 --sourcemap。
    sourcemap: withSourcemap,
    // E-17：刻意不开启 minify——保留可读源码与注释，便于用户对 vsix 内扩展代码做安全审计。
    // （与 sourcemap 的取舍方向不同：sourcemap 关闭是避免发布源码映射，这里是有意保留可读性；
    //   若日后改为 minify: true，可配合 legalComments: 'inline' 保留许可证头。）
    minify: false,
    keepNames: true,
    tsconfig: 'tsconfig.json',
    define: {
        // watch 模式下保留 development 语义，正式构建固定为 production
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    },
};

/**
 * 复制原生包及其全部传递依赖到 dist/node_modules（保持 require 路径）
 *
 * node-notifier 被标记为 external，不会被 esbuild 打进 bundle，
 * 因此它自身的运行时依赖（growly/semver/uuid 等）也必须一并复制，
 * 否则安装 vsix 后 require 会找不到模块。
 */
function copyNativePackages() {
    // E-18：复制前整体清空 dist/node_modules——历史上复制过、现已移出配置的包
    // 不会残留在 dist 中被一起打包（白名单裁剪不做，保持整包复制语义）。
    // 注意只清 node_modules 子目录：dist/extension.js 由 esbuild 构建产出，不能动。
    fs.rmSync(path.join(outdir, 'node_modules'), { recursive: true, force: true });

    /** 已处理的包名集合，避免循环依赖重复复制 */
    const visited = new Set();

    /** 从某个目录开始向上查找包（模拟 Node 的模块解析） */
    function resolvePackageDir(pkgName, fromDir) {
        let dir = fromDir;
        while (true) {
            const candidate = path.join(dir, 'node_modules', pkgName);
            if (fs.existsSync(path.join(candidate, 'package.json'))) {
                return fs.realpathSync(candidate);
            }
            const parent = path.dirname(dir);
            if (parent === dir) return null;
            dir = parent;
        }
    }

    function copyWithDeps(pkgName, fromDir) {
        if (visited.has(pkgName)) return;
        visited.add(pkgName);

        const src = resolvePackageDir(pkgName, fromDir);
        if (!src) {
            console.warn(`[esbuild] WARNING: cannot resolve package: ${pkgName}`);
            return;
        }

        const dest = path.join(outdir, 'node_modules', pkgName);
        // dereference: pnpm 下包内部可能含 symlink，复制真实文件
        fs.cpSync(src, dest, { recursive: true, dereference: true });
        console.log(`[esbuild] copied: ${pkgName} → dist/node_modules/${pkgName}`);

        const pkgJson = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
        for (const dep of Object.keys(pkgJson.dependencies || {})) {
            copyWithDeps(dep, src);
        }
    }

    for (const pkg of nativePackages) {
        copyWithDeps(pkg, __dirname);
    }
}

async function build() {
    if (isWatch) {
        // 监听模式：文件变更时自动重新打包
        const ctx = await esbuild.context({
            ...buildOptions,
            plugins: [
                {
                    name: 'rebuild-logger',
                    setup(build) {
                        build.onEnd((result) => {
                            const time = new Date().toLocaleTimeString();
                            if (result.errors.length > 0) {
                                console.error(`[esbuild][${time}] rebuild failed with ${result.errors.length} error(s)`);
                            } else {
                                console.log(`[esbuild][${time}] rebuild done`);
                            }
                        });
                    },
                },
            ],
        });
        copyNativePackages();
        await ctx.watch();
        console.log('[esbuild] watching for changes... (Ctrl+C to stop)');
        return;
    }

    // 单次构建
    await esbuild.build(buildOptions);
    copyNativePackages();
    console.log('[esbuild] bundle done');
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
