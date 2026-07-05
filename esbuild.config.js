/**
 * LimCode esbuild bundle 配置
 *
 * 将 extension.ts 打包为 dist/extension.js，替代原有的 tsc 直出方案。
 * node-notifier 等含原生二进制的包使用 copy loader 保留在 node_modules 中。
 *
 * 用法：
 *   node esbuild.config.js          # 单次构建
 *   node esbuild.config.js --watch  # 监听模式（文件变更自动重新打包）
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

// 需要在 node_modules 中保留原生文件的包（不能打进 bundle）
const externalModules = [
    'vscode',
    'typescript',
];

// 需要复制 .node 原生文件/资源到 dist 的包
const nativePackages = [
    'node-notifier',
];

const outdir = path.join(__dirname, 'dist');
const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['extension.ts'],
    bundle: true,
    outfile: path.join(outdir, 'extension.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: externalModules.concat(nativePackages),
    sourcemap: true,
    minify: false,
    keepNames: true,
    tsconfig: 'tsconfig.json',
    define: {
        'process.env.NODE_ENV': '"production"',
    },
};

/**
 * 复制原生包的 node_modules 到 dist（保持 require 路径）
 */
function copyNativePackages() {
    for (const pkg of nativePackages) {
        const src = path.join(__dirname, 'node_modules', pkg);
        const dest = path.join(outdir, 'node_modules', pkg);
        if (fs.existsSync(src)) {
            // pnpm 下 src 可能是 symlink：先清理旧目标，再解引用复制真实文件，
            // 避免重复构建 EEXIST，也避免 dist 中残留无效链接影响 vsix 打包
            fs.rmSync(dest, { recursive: true, force: true });
            fs.cpSync(src, dest, { recursive: true, dereference: true });
            console.log(`[esbuild] copied native package: ${pkg} → dist/node_modules/${pkg}`);
        }
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
