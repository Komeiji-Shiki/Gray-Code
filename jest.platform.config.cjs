const path = require('node:path');
// 平台使用 Node 22 的压缩等 API，类型来源与 core 构建一致；扩展继续使用根目录的 Node 20 类型。
const coreTypeRoot = path.dirname(path.dirname(require.resolve('@types/node/package.json', { paths: [path.join(__dirname, 'packages/core')] })));

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages/core/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20000,
  moduleNameMapper: {
    '^@graycode/contracts$': '<rootDir>/packages/contracts/src/index.ts',
  },
  // ACP 的稳定 SDK 使用 ESM；只转换该依赖，保持实际 stdio 集成测试走生产客户端。
  transformIgnorePatterns: [String.raw`node_modules[/\\](?!@agentclientprotocol[/\\]sdk[/\\])`],
  transform: {
    [String.raw`@agentclientprotocol[/\\]sdk[/\\].+\.js$`]: ['ts-jest', { tsconfig: { allowJs: true, target: 'ES2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true }, diagnostics: false }],
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Match existing backend strictness for the manager integration. build:platform checks the core with strict: true.
        target: 'ES2022', lib: ['ES2023'], module: 'commonjs', strict: false, strictNullChecks: true,
        noImplicitThis: true, strictFunctionTypes: true, strictBindCallApply: true,
        esModuleInterop: true, skipLibCheck: true, types: ['node', 'jest'],
        typeRoots: [coreTypeRoot, path.join(__dirname, 'node_modules/@types')],
      },
    }],
  },
};
