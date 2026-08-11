/**
 * progress.md 写互斥测试
 *
 * 覆盖：withProgressWriteLock 的串行/隔离/失败传播语义；并发 autoSync
 *      （design + plan / review 同时同步）不互相覆盖；update_progress 与
 *      record_progress_milestone 并发写不互相覆盖。
 *
 * 说明：vscode.workspace.fs 由 backend/__tests__/__mocks__/vscode.ts 提供，
 *      这里把它 mock 成带固定延迟的内存文件系统，让「读 → 改 → 写」的并发窗口
 *      真实出现——修复前两个写者会基于同一旧盘面计算并互相覆盖。
 */

import * as vscode from 'vscode';
import {
  withProgressWriteLock,
  getProgressWriteQueueSize,
} from '../../tools/progress/progressWriteLock';
import {
  syncProgressFromDesignArtifact,
  syncProgressFromPlanArtifact,
  syncProgressFromReviewArtifact,
} from '../../tools/progress/autoSync';
import { createUpdateProgressTool } from '../../tools/progress/update_progress';
import { createRecordProgressMilestoneTool } from '../../tools/progress/record_progress_milestone';
import { validateProgressDocument } from '../../tools/progress/documentLayout';
import type { ProgressDocumentMetadataV1 } from '../../tools/progress/schema';

const PROGRESS_RELATIVE_PATH = '.graycode/progress.md';
const READ_DELAY_MS = 5;
const WRITE_DELAY_MS = 5;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createWorkspaceFolder(name: string) {
  return {
    name,
    uri: { fsPath: `/workspace/${name}`, scheme: 'file', path: `/workspace/${name}` },
    index: 0,
  };
}

/** 内存文件系统：读/写都带固定延迟 */
const files = new Map<string, Buffer>();

function progressUri(): vscode.Uri {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, PROGRESS_RELATIVE_PATH);
}

function readProgressMetadata(): ProgressDocumentMetadataV1 {
  const raw = files.get(progressUri().fsPath);
  expect(raw).toBeDefined();
  const validation = validateProgressDocument(raw!.toString('utf-8'));
  expect(validation.success).toBe(true);
  if (!validation.success) {
    throw new Error('Unexpected validation failure');
  }
  return validation.metadata;
}

beforeEach(() => {
  files.clear();
  (vscode.workspace.workspaceFolders as any) = [createWorkspaceFolder('ws1')];
  jest.clearAllMocks();
  (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: any) => {
    await delay(READ_DELAY_MS);
    if (!files.has(uri.fsPath)) {
      const err: any = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    }
    return new Uint8Array(files.get(uri.fsPath)!);
  });
  (vscode.workspace.fs.writeFile as jest.Mock).mockImplementation(async (uri: any, data: Uint8Array) => {
    await delay(WRITE_DELAY_MS);
    files.set(uri.fsPath, Buffer.from(data));
  });
  (vscode.workspace.fs.createDirectory as jest.Mock).mockResolvedValue(undefined);
});

describe('withProgressWriteLock - 单元语义', () => {
  test('同一路径的写操作按调用顺序串行，绝不重叠执行', async () => {
    const order: number[] = [];
    let running = 0;
    let maxActive = 0;

    const task = (id: number) => withProgressWriteLock('p.md', async () => {
      running += 1;
      maxActive = Math.max(maxActive, running);
      order.push(id);
      await delay(10);
      running -= 1;
    });

    await Promise.all([task(1), task(2), task(3)]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
    expect(getProgressWriteQueueSize()).toBe(0);
  });

  test('不同路径互不阻塞', async () => {
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { releaseA = resolve; });
    let aStarted = false;

    const a = withProgressWriteLock('a.md', async () => {
      aStarted = true;
      await gate;
    });

    await delay(20);
    expect(aStarted).toBe(true);

    const b = withProgressWriteLock('b.md', async () => 'b-done');
    await expect(b).resolves.toBe('b-done');

    releaseA();
    await a;
    expect(getProgressWriteQueueSize()).toBe(0);
  });

  test('前一个写失败不会阻塞后续写入，错误传播给调用方', async () => {
    const first = withProgressWriteLock('p.md', async () => {
      throw new Error('boom');
    });
    await expect(first).rejects.toThrow('boom');

    const second = withProgressWriteLock('p.md', async () => 'ok');
    await expect(second).resolves.toBe('ok');
    expect(getProgressWriteQueueSize()).toBe(0);
  });
});

describe('autoSync 并发 - 不互相覆盖', () => {
  test('design 与 plan 同时同步 progress.md，两个 artifact 与两条 log 都保留', async () => {
    const [designWarnings, planWarnings] = await Promise.all([
      syncProgressFromDesignArtifact({ designPath: '.graycode/design/a.md', title: '设计 A' }),
      syncProgressFromPlanArtifact({
        planPath: '.graycode/plans/b.md',
        title: '计划 B',
        todos: [{ id: 't1', content: 'todo1', status: 'pending' }],
      }),
    ]);

    expect(designWarnings).toEqual([]);
    expect(planWarnings).toEqual([]);

    const metadata = readProgressMetadata();
    expect(metadata.activeArtifacts.design).toBe('.graycode/design/a.md');
    expect(metadata.activeArtifacts.plan).toBe('.graycode/plans/b.md');
    expect(metadata.todos).toHaveLength(1);
    expect(metadata.log.filter(entry => entry.type === 'artifact_changed')).toHaveLength(2);
  });

  test('design 与 review 同时同步，两个 artifact 都保留', async () => {
    const [designWarnings, reviewWarnings] = await Promise.all([
      syncProgressFromDesignArtifact({ designPath: '.graycode/design/c.md' }),
      syncProgressFromReviewArtifact({ reviewPath: '.graycode/review/r.md', latestConclusion: '审查结论' }),
    ]);

    expect(designWarnings).toEqual([]);
    expect(reviewWarnings).toEqual([]);

    const metadata = readProgressMetadata();
    expect(metadata.activeArtifacts.design).toBe('.graycode/design/c.md');
    expect(metadata.activeArtifacts.review).toBe('.graycode/review/r.md');
  });
});

describe('update_progress / record_progress_milestone 并发 - 不互相覆盖', () => {
  /** 先用 autoSync 建一份初始文档（顺带覆盖 autoSync → 写锁入口） */
  async function seedInitialProgress(): Promise<void> {
    const warnings = await syncProgressFromDesignArtifact({ designPath: '.graycode/design/seed.md' });
    expect(warnings).toEqual([]);
  }

  test('两个 update_progress 并发追加，todos/risks/log 都不丢失', async () => {
    await seedInitialProgress();
    const tool = createUpdateProgressTool();

    const [r1, r2] = await Promise.all([
      tool.handler({
        appendLog: [{ type: 'updated', message: 'A 更新' }],
        todos: [{ id: 'ta', content: 'A todo', status: 'pending' }],
      }),
      tool.handler({
        appendLog: [{ type: 'updated', message: 'B 更新' }],
        risks: [{ id: 'ra', title: '风险', status: 'active', description: 'desc' }],
      }),
    ]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);

    const metadata = readProgressMetadata();
    expect(metadata.todos.map(t => t.id)).toEqual(['ta']);
    expect(metadata.risks.map(r => r.id)).toEqual(['ra']);
    expect(metadata.log.some(entry => entry.message === 'A 更新')).toBe(true);
    expect(metadata.log.some(entry => entry.message === 'B 更新')).toBe(true);
  });

  test('update_progress 与 record_progress_milestone 并发，里程碑与 log 都保留', async () => {
    await seedInitialProgress();
    const updateTool = createUpdateProgressTool();
    const milestoneTool = createRecordProgressMilestoneTool();

    const [milestoneResult, updateResult] = await Promise.all([
      milestoneTool.handler({
        title: '并发修复完成',
        summary: '两处并发一致性修复',
        relatedArtifacts: { design: '.graycode/design/seed.md' },
      }),
      updateTool.handler({
        appendLog: [{ type: 'updated', message: '同步更新' }],
        currentFocus: '修复并发问题',
      }),
    ]);

    expect(milestoneResult.success).toBe(true);
    expect(updateResult.success).toBe(true);

    const metadata = readProgressMetadata();
    expect(metadata.milestones).toHaveLength(1);
    expect(metadata.milestones[0].title).toBe('并发修复完成');
    expect(metadata.currentFocus).toBe('修复并发问题');
    expect(metadata.log.some(entry => entry.type === 'milestone_recorded')).toBe(true);
    expect(metadata.log.some(entry => entry.message === '同步更新')).toBe(true);
  });
});
