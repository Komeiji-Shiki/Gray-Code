import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importLegacyHistory } from '@graycode/core';
import { fixture, message, metadata } from './fixtures';
import { convertCheckpoint } from '../../../apps/server/src/migration/service';

const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');
const rootA = { id: 'ws_1111111111111111', name: 'rootA', uri: 'file:///tmp/rootA' };
const rootB = { id: 'ws_2222222222222222', name: 'rootB', uri: 'file:///tmp/rootB' };

describe('旧检查点转换器（B1）', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  async function writeHistory(id: string) {
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.meta.json`), JSON.stringify({
      ...metadata(id),
      custom: { checkpoints: [] },
    }));
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.json`), JSON.stringify([message(0)]));
  }

  async function writeBackupFile(backupDir: string, scopedPath: string, bytes: Uint8Array | string) {
    const file = path.join(f.source, 'checkpoints', backupDir, ...scopedPath.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  }

  test('多根、增量链、排除与局部范围语义迁移为内容记录+清单', async () => {
    const id = 'cpconv';
    const checkpointsDir = path.join(f.source, 'checkpoints');
    await fs.mkdir(checkpointsDir, { recursive: true });

    const aFull = Buffer.from('hello full');
    const bFull = Buffer.from([0, 1, 255]);
    const aInc = Buffer.from('hello inc');
    const cInc = Buffer.from('new file');
    const partialBytes = Buffer.from('partial content');

    // cp_full：v1 内联 manifest，多根。
    const fullFiles = {
      [`${rootA.id}/a.txt`]: { hash: md5(aFull), size: aFull.length, mtimeMs: 0 },
      [`${rootB.id}/b.txt`]: { hash: md5(bFull), size: bFull.length, mtimeMs: 0 },
    };
    await writeBackupFile('cp_full', `${rootA.id}/a.txt`, aFull);
    await writeBackupFile('cp_full', `${rootB.id}/b.txt`, bFull);
    await fs.writeFile(path.join(checkpointsDir, 'cp_full', 'manifest.json'), JSON.stringify({
      version: 1, checkpointId: 'cp_full', workspaceRoots: [rootA, rootB], files: fullFiles,
      emptyDirs: [`${rootA.id}/empty`], changes: [], excluded: [{ path: `${rootA.id}/skip.log`, reason: 'size', size: 10 }],
      ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] },
    }));
    const fullManifestBefore = await fs.readFile(path.join(checkpointsDir, 'cp_full', 'manifest.json'));

    // cp_inc：v2 拆分 manifest，增量（备份目录仅含 delta），基于 cp_full。
    const incFullMap = {
      [`${rootA.id}/a.txt`]: { hash: md5(aInc), size: aInc.length, mtimeMs: 0 },
      [`${rootB.id}/b.txt`]: { hash: md5(bFull), size: bFull.length, mtimeMs: 0 },
      [`${rootA.id}/c.txt`]: { hash: md5(cInc), size: cInc.length, mtimeMs: 0 },
    };
    await writeBackupFile('cp_inc', `${rootA.id}/a.txt`, aInc);
    await writeBackupFile('cp_inc', `${rootA.id}/c.txt`, cInc);
    await fs.writeFile(path.join(checkpointsDir, 'cp_inc', 'manifest.json'), JSON.stringify({
      version: 2, checkpointId: 'cp_inc', workspaceRoots: [rootA, rootB],
      emptyDirs: [], changes: [{ path: `${rootA.id}/a.txt`, type: 'modified' }, { path: `${rootA.id}/c.txt`, type: 'added' }],
      excluded: [], ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] },
      filesRevision: 'rev-1',
    }));
    await fs.writeFile(path.join(checkpointsDir, 'cp_inc', 'files.json'), JSON.stringify({
      checkpointId: 'cp_inc', filesRevision: 'rev-1', files: incFullMap,
    }));

    // cp_partial：局部快照，含 absent。
    await writeBackupFile('cp_partial', `${rootA.id}/only.txt`, partialBytes);
    await fs.writeFile(path.join(checkpointsDir, 'cp_partial', 'manifest.json'), JSON.stringify({
      version: 2, checkpointId: 'cp_partial', workspaceRoots: [rootA], files: { [`${rootA.id}/only.txt`]: { hash: md5(partialBytes), size: partialBytes.length, mtimeMs: 0 } },
      emptyDirs: [], changes: [], excluded: [], ignoreSnapshot: { version: 1, forcedRulesVersion: 1, defaultProfileVersion: 1, enabledProfiles: {}, maxFileSizeBytes: 0, customPatterns: [] },
      absentPaths: [`${rootA.id}/missing.txt`], partial: true, filesRevision: 'rev-p',
    }));
    await fs.writeFile(path.join(checkpointsDir, 'cp_partial', 'files.json'), JSON.stringify({
      checkpointId: 'cp_partial', filesRevision: 'rev-p', files: { [`${rootA.id}/only.txt`]: { hash: md5(partialBytes), size: partialBytes.length, mtimeMs: 0 } },
    }));

    const fullRecord = {
      id: 'cp_full', conversationId: id, messageIndex: 0, toolName: 'write_file', phase: 'after', timestamp: 1000,
      backupDir: 'cp_full', fileCount: 2, contentHash: 'abc', type: 'full', fileHashes: {
        [`${rootA.id}/a.txt`]: md5(aFull), [`${rootB.id}/b.txt`]: md5(bFull),
      }, workspaceRoots: [rootA, rootB], emptyDirs: [`${rootA.id}/empty`],
    };
    const incRecord = {
      id: 'cp_inc', conversationId: id, messageIndex: 1, toolName: 'write_file', phase: 'after', timestamp: 2000,
      backupDir: 'cp_inc', fileCount: 2, contentHash: 'def', type: 'incremental', baseCheckpointId: 'cp_full',
      changes: [{ path: `${rootA.id}/a.txt`, type: 'modified' }, { path: `${rootA.id}/c.txt`, type: 'added' }],
      fileHashes: {
        [`${rootA.id}/a.txt`]: md5(aInc), [`${rootB.id}/b.txt`]: md5(bFull), [`${rootA.id}/c.txt`]: md5(cInc),
      }, workspaceRoots: [rootA, rootB], emptyDirs: [],
    };
    const partialRecord = {
      id: 'cp_partial', conversationId: id, messageIndex: 2, toolName: 'write_file', phase: 'after', timestamp: 3000,
      backupDir: 'cp_partial', fileCount: 1, contentHash: 'ghi', type: 'full', partial: true,
      fileHashes: { [`${rootA.id}/only.txt`]: 'old' }, workspaceRoots: [rootA],
      absentPaths: [`${rootA.id}/missing.txt`],
    };
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.meta.json`), JSON.stringify({
      ...metadata(id), custom: { checkpoints: [fullRecord, incRecord, partialRecord] },
    }));
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.json`), JSON.stringify([message(0)]));

    const report = await importLegacyHistory(f.store, f.source, {
      convertCheckpoint,
    });
    expect(report.issues).toEqual([]);
    expect(report.artifacts?.checkpoints.length).toBeGreaterThan(0);
    // 源目录只读：备份与清单字节不变。
    expect(await fs.readFile(path.join(checkpointsDir, 'cp_full', 'manifest.json'))).toEqual(fullManifestBefore);

    // cp_full 校验：多根、emptyDirs、excluded 保留；hash/size/mode 来自实际字节。
    const full = await f.store.getRecord('workspace-checkpoints', 'cp_full') as any;
    expect(full.conversationId).toBe(id);
    expect(full.manifest.version).toBe(1);
    expect(full.manifest.roots).toEqual(expect.arrayContaining([expect.objectContaining(rootA), expect.objectContaining(rootB)]));
    expect(full.manifest.emptyDirs).toEqual([`${rootA.id}/empty`]);
    expect(full.manifest.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ path: `${rootA.id}/skip.log`, reason: 'size' })]));
    expect(Object.keys(full.manifest.files).sort()).toEqual([`${rootA.id}/a.txt`, `${rootB.id}/b.txt`].sort());
    const aStat = await fs.stat(path.join(checkpointsDir, 'cp_full', rootA.id, 'a.txt'));
    expect(full.manifest.files[`${rootA.id}/a.txt`]).toMatchObject({ hash: md5(aFull), size: aFull.byteLength, mode: (aStat.mode & 0o777) });
    const bStat = await fs.stat(path.join(checkpointsDir, 'cp_full', rootB.id, 'b.txt'));
    expect(full.manifest.files[`${rootB.id}/b.txt`]).toMatchObject({ hash: md5(bFull), size: bFull.byteLength, mode: (bStat.mode & 0o777) });
    const fullAContent = await f.store.getRecord('workspace-checkpoint-content', full.contentIds[`${rootA.id}/a.txt`]) as unknown;
    expect(Buffer.from(fullAContent as Uint8Array)).toEqual(aFull);
    const fullBContent = await f.store.getRecord('workspace-checkpoint-content', full.contentIds[`${rootB.id}/b.txt`]) as unknown;
    expect(Buffer.from(fullBContent as Uint8Array)).toEqual(bFull);

    // cp_inc 校验：增量链自包含，未变化文件经基线回溯补齐。
    const inc = await f.store.getRecord('workspace-checkpoints', 'cp_inc') as any;
    expect(Object.keys(inc.manifest.files).sort()).toEqual(
      [`${rootA.id}/a.txt`, `${rootA.id}/c.txt`, `${rootB.id}/b.txt`].sort(),
    );
    expect(inc.manifest.files[`${rootA.id}/a.txt`].hash).toBe(md5(aInc));
    expect(inc.manifest.files[`${rootB.id}/b.txt`].hash).toBe(md5(bFull));
    const incBContent = await f.store.getRecord('workspace-checkpoint-content', inc.contentIds[`${rootB.id}/b.txt`]) as unknown;
    expect(Buffer.from(incBContent as Uint8Array)).toEqual(bFull);

    // cp_partial 校验：局部范围与缺失语义保留。
    const partial = await f.store.getRecord('workspace-checkpoints', 'cp_partial') as any;
    expect(partial.manifest.partial).toBe(true);
    expect(partial.manifest.absentPaths).toEqual([`${rootA.id}/missing.txt`]);
    expect(partial.manifest.files[`${rootA.id}/only.txt`].hash).toBe(md5(partialBytes));
  });

  test('旧相对布局与无 manifest 记录回退到 fileHashes 口径', async () => {
    const id = 'cprel';
    await writeHistory(id);
    const bytes = Buffer.from('relative content');
    const backupFile = path.join(f.source, 'checkpoints', 'cp_rel', 'rel.txt');
    await fs.mkdir(path.dirname(backupFile), { recursive: true });
    await fs.writeFile(backupFile, bytes);
    const subFile = path.join(f.source, 'checkpoints', 'cp_rel', 'sub', 'dir.txt');
    await fs.mkdir(path.dirname(subFile), { recursive: true });
    await fs.writeFile(subFile, 'sub content');
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.meta.json`), JSON.stringify({
      ...metadata(id),
      custom: { checkpoints: [{
        id: 'cp_rel', conversationId: id, messageIndex: 0, toolName: 'legacy_tool', phase: 'before', timestamp: 1000,
        backupDir: 'cp_rel', fileCount: 2, contentHash: 'x',
        workspaceRoots: [rootA], fileHashes: { 'rel.txt': md5(bytes), 'sub/dir.txt': md5(Buffer.from('sub content')) },
        emptyDirs: [], unbackedPaths: ['skip.txt'],
      }] },
    }));
    const report = await importLegacyHistory(f.store, f.source, {
      conversationIds: [id],
      convertCheckpoint: (conversationId, root) => convertCheckpoint(conversationId, root),
    });
    expect(report.issues).toEqual([]);
    const checkpoint = await f.store.getRecord('workspace-checkpoints', 'cp_rel') as any;
    expect(checkpoint.toolName).toBe('legacy_tool');
    expect(checkpoint.phase).toBe('before');
    // 相对键归一化为 scoped，且内容可读。
    const keys = Object.keys(checkpoint.manifest.files);
    expect(keys).toHaveLength(2);
    expect(keys.every(key => /^ws_[a-f0-9]{16}\//.test(key))).toBe(true);
    const relKey = keys.find(key => key.endsWith('/rel.txt'))!;
    expect(checkpoint.manifest.files[relKey].hash).toBe(md5(bytes));
    const stored = await f.store.getRecord('workspace-checkpoint-content', checkpoint.contentIds[relKey]) as unknown;
    expect(Buffer.from(stored as Uint8Array)).toEqual(bytes);
    // unbackedPaths 近似为 excluded。
    expect(checkpoint.manifest.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'unreadable', source: 'legacy' })]));
  });

  test('无检查点元数据时不报错且不产生记录', async () => {
    const id = 'nocp';
    await writeHistory(id);
    const result = await convertCheckpoint(id, f.source);
    expect(result.records).toEqual([]);
    expect(result.consumed).toEqual([]);
  });
});
