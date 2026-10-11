import { createSubagentsDeclaration } from '../../tools/subagents/createDeclaration';

test('工具声明暴露 background 参数', () => {
    const decl = createSubagentsDeclaration({
        agentNames: ['Test Agent'],
        isZh: true,
        description: '子代理声明夹具',
        agentNameDescription: '子代理名称'
    });
    // 动态说明由平台宿主生成；这里只保留原用例对共享参数声明的断言。
    expect(decl.parameters.properties.background).toBeDefined();
    expect((decl.parameters.properties.background as { type: string }).type).toBe('boolean');
});
