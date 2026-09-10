module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages/core/tests'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 20000,
  moduleNameMapper: {
    '^@graycode/contracts$': '<rootDir>/packages/contracts/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        // Match existing backend strictness for the manager integration. build:platform checks the core with strict: true.
        target: 'ES2022', lib: ['ES2023'], module: 'commonjs', strict: false, strictNullChecks: true,
        noImplicitThis: true, strictFunctionTypes: true, strictBindCallApply: true,
        esModuleInterop: true, skipLibCheck: true, types: ['node', 'jest'],
      },
    }],
  },
};
