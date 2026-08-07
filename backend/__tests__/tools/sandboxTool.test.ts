/**
 * Sandbox 工具测试（SANDBOX-02）
 *
 * 覆盖：正常执行与 stderr 合并、输出行数截断、语言白名单拒绝、
 * 空白名单=拒绝全部、总开关关闭拒绝、cleanupTempDir=false 保留临时目录、
 * 超时强制终止、未知语言拒绝。
 */
import { createSandboxTool } from '../../tools/sandbox';

function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
        enabled: true,
        allowedLanguages: ['javascript'],
        defaultTimeout: 10000,
        maxOutputLines: 20,
        cleanupTempDir: true,
        ...overrides
    };
}

describe('sandbox smoke', () => {
    it('javascript 运行与 stderr 合并', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'console.log("hello sandbox"); console.error("err line");', stdin: '' },
            { config: baseConfig() } as any
        );
        expect(r.success).toBe(true);
        expect(r.data?.output).toContain('hello sandbox');
        expect(r.data?.output).toContain('[stderr]');
        expect(r.data?.exitCode).toBe(0);
    });

    it('输出行数截断保留最后 N 行', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'for (let i=0;i<50;i++) console.log("line"+i);' },
            { config: baseConfig({ maxOutputLines: 5 }) } as any
        );
        expect(r.success).toBe(true);
        expect(r.data?.truncated).toBe(true);
        const lines = (r.data?.output as string).split('\n');
        expect(lines.length).toBe(5);
        expect(lines[lines.length - 1]).toBe('line49');
        expect(r.data?.truncatedNote).toContain('50');
    });

    it('语言白名单拒绝未允许语言', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'python', code: 'print("py")' },
            { config: baseConfig({ allowedLanguages: ['javascript'] }) } as any
        );
        expect(r.success).toBe(false);
        expect((r.error || '').toLowerCase()).toContain('not allowed');
    });

    it('空白名单 = 拒绝全部', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'console.log("x")' },
            { config: baseConfig({ allowedLanguages: [] }) } as any
        );
        expect(r.success).toBe(false);
        expect((r.error || '').toLowerCase()).toContain('not allowed');
    });

    it('总开关关闭拒绝执行', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'console.log("x")' },
            { config: baseConfig({ enabled: false }) } as any
        );
        expect(r.success).toBe(false);
        expect((r.error || '').toLowerCase()).toContain('disabled');
    });

    it('cleanupTempDir=false 时保留临时目录', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'console.log("ok")' },
            { config: baseConfig({ cleanupTempDir: false }) } as any
        );
        expect(r.success).toBe(true);
        expect(typeof r.data?.tempDir).toBe('string');
        const fs = require('fs');
        expect(fs.existsSync(r.data.tempDir)).toBe(true);
        fs.rmSync(r.data.tempDir, { recursive: true, force: true });
    });

    it('超时强制终止并标记 timedOut', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'javascript', code: 'while(true){}' },
            { config: baseConfig({ defaultTimeout: 1000 }) } as any
        );
        expect(r.success).toBe(false);
        expect((r.error || '').toLowerCase()).toContain('timed out');
    });

    it('未知语言参数被拒绝', async () => {
        const tool = createSandboxTool();
        const r = await tool.handler(
            { language: 'cobol', code: 'x' },
            { config: baseConfig() } as any
        );
        expect(r.success).toBe(false);
        expect((r.error || '').toLowerCase()).toContain('unsupported language');
    });
});
