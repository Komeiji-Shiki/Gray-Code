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
  // ACP 和 JOSE 使用 ESM；定向转换这两个正式依赖，测试仍使用实际协议和签名验证实现。
  transformIgnorePatterns: [String.raw`node_modules[/\\](?!@agentclientprotocol[/\\]sdk[/\\]|jose[/\\])`],
  transform: {
    [String.raw`(?:@agentclientprotocol[/\\]sdk|jose)[/\\].+\.js$`]: ['ts-jest', { tsconfig: { allowJs: true, target: 'ES2022', module: 'commonjs', esModuleInterop: true, skipLibCheck: true }, diagnostics: false }],
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
