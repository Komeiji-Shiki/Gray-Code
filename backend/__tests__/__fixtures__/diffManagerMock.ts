/**
 * 测试共享 fixture：注册 diffManager 模块级 jest.mock（副作用模块）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（模块化重构第六批）：
 * - 原在 6 个 checkpoint 测试中以完全相同的 6 行 jest.mock 内联注册，
 *   收敛为单一副作用模块：导入即完成 mock 注册。
 * - 用法：在被测模块 import 之前以副作用方式引入（须排在文件最前）：
 *     import '../../__fixtures__/diffManagerMock';
 * - jest.mock 路径相对本文件解析，与消费方原内联写法解析到同一模块
 *   （backend/tools/file/diffManager）。
 */
jest.mock('../../tools/file/diffManager', () => ({
    getDiffManager: () => ({
        cancelAllPending: jest.fn().mockResolvedValue({ cancelled: [] })
    })
}));
