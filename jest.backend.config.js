/** @type {import('jest').Config} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    // roots 收敛：只扫描真实测试目录（backend/__tests__ 与 test/benchmark）；
    // test/unit 已归位清空（tools/settings → backend/__tests__，frontend/stores → frontend/src vitest 域），
    // test/benchmark 保留为独立 root，benchmark 脚本通过 --testMatch "**/*.benchmark.ts" 单独运行
    roots: ['<rootDir>/backend/__tests__', '<rootDir>/test/benchmark'],
    testMatch: ['**/*.test.ts'],
    moduleNameMapper: {
        '^vscode$': '<rootDir>/backend/__tests__/__mocks__/vscode.ts',
        '^@/(.*)$': '<rootDir>/frontend/src/$1',
        // 与 tsconfig.test.json 的 '@shared/*' paths 对应：前端 codec re-export '@shared/mcpToolNameCodec'，
        // backend jest 运行时需经此映射解析到 shared/ 目录（同 '@/' 映射机制）
        '^@shared/(.*)$': '<rootDir>/shared/$1',
    },
    // 全局超时：大量测试套件做真实磁盘 IO，默认 5s 在慢 CI 上会随机失败
    testTimeout: 20000,
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json',
        }],
    },
};
