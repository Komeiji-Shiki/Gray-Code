/**
 * workspaceRealpath：realpath 感知工作区包含性校验单元测试
 *
 * 覆盖：
 * - resolveRealpathForComparison：路径解析为真实路径、不存在路径降级词法（最近存在祖先）
 * - isUriInsideWorkspaceRealpath：工作区内正常文件 true、工作区外 false、无工作区 false
 * - symlink 逃逸：工作区内 symlink 指向工作区外文件时返回 false（安全修复回归护栏）
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  isUriInsideWorkspaceRealpath,
  resolveRealpathForComparison
} from '../../../webview/utils/workspaceRealpath';

describe('workspaceRealpath：realpath 感知工作区包含性校验', () => {
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-realpath-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-realpath-'));
    (vscode.workspace as any).workspaceFolders = [{
      name: 'project',
      uri: vscode.Uri.file(workspaceRoot)
    }];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (vscode.workspace as any).workspaceFolders = [];
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  test('resolveRealpathForComparison：存在路径返回真实路径，不存在路径降级词法（最近存在祖先）', async () => {
    const existing = path.join(workspaceRoot, 'exists.txt');
    fs.writeFileSync(existing, 'x');

    const realExisting = await resolveRealpathForComparison(existing);
    const realRoot = await resolveRealpathForComparison(workspaceRoot);
    expect(realExisting.startsWith(realRoot)).toBe(true);

    // 不存在路径：向上找到最近存在祖先（workspaceRoot），尾部段原样拼接
    const missing = path.join(workspaceRoot, 'no', 'such', 'file.txt');
    const realMissing = await resolveRealpathForComparison(missing);
    expect(realMissing.startsWith(realRoot)).toBe(true);
    expect(
      realMissing.endsWith('no/such/file.txt') || realMissing.endsWith(path.join('no', 'such', 'file.txt'))
    ).toBe(true);
  });

  test('工作区内正常文件返回 true', async () => {
    const file = path.join(workspaceRoot, 'inside.txt');
    fs.writeFileSync(file, 'x');
    expect(await isUriInsideWorkspaceRealpath(vscode.Uri.file(file))).toBe(true);
  });

  test('工作区根本身返回 true（等于语义）', async () => {
    expect(await isUriInsideWorkspaceRealpath(vscode.Uri.file(workspaceRoot))).toBe(true);
  });

  test('工作区外文件返回 false', async () => {
    const file = path.join(outsideRoot, 'secret.txt');
    fs.writeFileSync(file, 'x');
    expect(await isUriInsideWorkspaceRealpath(vscode.Uri.file(file))).toBe(false);
  });

  test('symlink 逃逸：工作区内 symlink 指向工作区外文件时返回 false', async () => {
    const target = path.join(outsideRoot, 'secret.txt');
    fs.writeFileSync(target, 'x');
    const linkPath = path.join(workspaceRoot, 'link.txt');

    // 模拟 realpath：link.txt 解析到工作区外目标（真实 symlink 创建在 CI 上不可靠，
    // Windows 需管理员/开发者模式，用 mock 模拟解析结果）
    const realRealpath = fs.promises.realpath.bind(fs.promises);
    jest.spyOn(fs.promises as any, 'realpath').mockImplementation(async (p: any) => {
      const resolved = path.resolve(p as string);
      if (resolved === linkPath) {
        return target;
      }
      return realRealpath(p);
    });

    // 词法前缀匹配会放行（link.txt 在词法上位于工作区内），realpath 感知校验必须拒绝
    expect(await isUriInsideWorkspaceRealpath(vscode.Uri.file(linkPath))).toBe(false);
  });

  test('无工作区时返回 false', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    const file = path.join(workspaceRoot, 'inside.txt');
    fs.writeFileSync(file, 'x');
    expect(await isUriInsideWorkspaceRealpath(vscode.Uri.file(file))).toBe(false);
  });
});
