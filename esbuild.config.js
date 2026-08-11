/**
 * GrayCode esbuild bundle 配置
 *
 * 将 extension.ts 打包为 dist/extension.js，替代原有的 tsc 直出方案。
 *
 * 用法：
 *   node esbuild.config.js          # 单次构建
 *   node esbuild.config.js --watch  # 监听模式（文件变更自动重新打包）
 */

const esbuild = require('esbuild');
const path = require('path');

// 需要在 node_modules 中保留的包（不能打进 bundle）
const externalModules = [
    'vscode',
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
    // 与根 package.json engines.node >=20 对齐（electron-app/build.mjs 已用 node22）
    target: 'node20',
    external: externalModules,
    // 单次构建（发布产物）压缩并关闭 sourcemap；watch 模式保留原始形态便于调试
    sourcemap: isWatch,
    minify: !isWatch,
    keepNames: true,
    tsconfig: 'tsconfig.json',
    define: {
        // watch 模式下保留 development 语义，正式构建固定为 production
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    },
};

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
        await ctx.watch();
        console.log('[esbuild] watching for changes... (Ctrl+C to stop)');
        return;
    }

    // 单次构建
    await esbuild.build(buildOptions);
    console.log('[esbuild] bundle done');
}

build().catch((e) => {
    console.error(e);
    process.exit(1);
});
