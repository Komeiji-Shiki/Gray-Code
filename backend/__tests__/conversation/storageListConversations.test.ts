/**
 * FileSystemStorageAdapter.listConversations 识别回归测试
 *
 * 回归背景：用量索引文件 {conversationId}.usage.json 与历史文件同级存放，
 * 而 listConversations 只排除了 .meta.json，导致 .usage.json 被识别成假对话
 * （ID 形如 xxx.usage）显示在历史列表，随后 getMetadata 失败报
 * "Metadata file is missing"。
 *
 * 本测试锁定：listConversations 只返回真实对话 ID（legacy {id}.json 与
 * segmented {id}/ 目录），排除 .meta.json 与 .usage.json，并排除
 * 历史 bug 增殖出的假对话目录（{id}.usage/）。
 */

import { FileSystemStorageAdapter } from '../../modules/conversation/storage';
import { Uri, workspace } from 'vscode';

describe('FileSystemStorageAdapter.listConversations - 只识别对话历史文件', () => {
    const fs = workspace.fs as any;

    beforeEach(() => {
        fs.readDirectory = jest.fn();
    });

    it('排除 meta.json 与 usage.json，只返回真实对话 ID', async () => {
        const vscode = { Uri, workspace, FileType: { File: 1, Directory: 2 } };
        const adapter = new FileSystemStorageAdapter(vscode as any, 'file:///c%3A/data/graycode');

        fs.readDirectory.mockResolvedValue([
            ['conv_a.json', 1], // legacy 历史 → 真对话
            ['conv_a.meta.json', 1], // 元数据 → 排除
            ['conv_a.usage.json', 1], // 用量索引 → 排除（回归点）
            ['conv_b', 2], // segmented 目录 → 真对话
            ['conv_b.meta.json', 1] // 分段对话的元数据 → 排除
        ]);

        const ids = await adapter.listConversations();
        expect(ids).toEqual(expect.arrayContaining(['conv_a', 'conv_b']));
        expect(ids).not.toContain('conv_a.meta');
        expect(ids).not.toContain('conv_a.usage');
        expect(ids).not.toContain('conv_b.meta');
    });

    it('排除假对话目录（{id}.usage/），只返回真实对话目录', async () => {
        const vscode = { Uri, workspace, FileType: { File: 1, Directory: 2 } };
        const adapter = new FileSystemStorageAdapter(vscode as any, 'file:///c%3A/data/graycode');

        fs.readDirectory.mockResolvedValue([
            ['conv_a', 2], // segmented 目录 → 真对话
            ['conv_b', 2], // segmented 目录 → 真对话
            ['conv_a.usage', 2], // 假对话目录（旧 bug 增殖产物）→ 排除（回归点）
            ['conv_b.usage', 2], // 假对话目录 → 排除
            ['conv_a.usage.json', 1], // 用量索引文件 → 排除
            ['conv_a.meta.json', 1] // 元数据 → 排除
        ]);

        const ids = await adapter.listConversations();
        expect(ids).toEqual(expect.arrayContaining(['conv_a', 'conv_b']));
        expect(ids).not.toContain('conv_a.usage');
        expect(ids).not.toContain('conv_b.usage');
    });
});
