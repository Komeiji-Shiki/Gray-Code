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
    },
};
