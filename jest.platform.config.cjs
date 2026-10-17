const path = require('node:path');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages/core/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20000,
  // 平台用例以真实磁盘、HTTP 和子进程为主；超过两个 worker 会争抢 I/O，让 20 秒超时用例偶发失败。
  // 两个 worker 的完整运行时长与 50% 核心接近，但内存占用和超时抖动更低。
  maxWorkers: 2,
  workerIdleMemoryLimit: '768MB',
  moduleNameMapper: {
    '^@graycode/contracts$': '<rootDir>/packages/contracts/src/index.ts',
  },
  // ACP 和 JOSE 使用 ESM；定向转换这两个正式依赖，测试仍使用实际协议和签名验证实现。
  transformIgnorePatterns: [String.raw`node_modules[/\\](?!@agentclientprotocol[/\\]sdk[/\\]|jose[/\\])`],
  transform: {
    [String.raw`(?:@agentclientprotocol[/\\]sdk|jose)[/\\].+\.js$`]: ['ts-jest', { tsconfig: { allowJs: true, target: 'ES2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true }, diagnostics: false }],
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Match existing backend strictness for the manager integration. build:platform checks the core with strict: true.
        // isolatedModules：只转译不建类型程序，类型由 typecheck:platform 与 build:platform 检查。
        isolatedModules: true,
        target: 'ES2022', lib: ['ES2023'], module: 'commonjs', strict: false, strictNullChecks: true,
        noImplicitThis: true, strictFunctionTypes: true, strictBindCallApply: true,
        esModuleInterop: true, skipLibCheck: true, types: ['node', 'jest'],
        typeRoots: [path.join(__dirname, 'node_modules/@types')],
      },
    }],
  },
};
