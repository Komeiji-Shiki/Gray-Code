/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/backend', '<rootDir>/test'],
    testMatch: ['**/*.test.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/backend/__tests__/__mocks__/vscode.ts',
        '^@/(.*)$': '<rootDir>/frontend/src/$1',
    },
    // 全局超时：大量测试套件做真实磁盘 IO，默认 5s 在慢 CI 上会随机失败
    testTimeout: 20000,
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json',
        }],
        // jsdom 依赖链中的 ESM-only 包（@exodus/bytes、@asamuzakjp/*、jsdom 嵌套的
        // parse5/entities）：转为 CJS
        'node_modules[\\\\/]((?:@exodus|@asamuzakjp|@csstools)[\\\\/][^\/]+|jsdom[\\\\/]node_modules[\\\\/](?:parse5|entities))[\\\\/].*\.(?:js|mjs)$': '<rootDir>/test/transform/esm-cjs-transform.js',
    },
    // 仅放行上述 ESM 包参与转换，其余 node_modules 保持原样
    transformIgnorePatterns: ['^(?!.*node_modules/((?:@exodus|@asamuzakjp|@csstools)/[^/]+|jsdom/node_modules/(?:parse5|entities))/).*node_modules/.*$'],
};
