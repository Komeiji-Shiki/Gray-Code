import { validateRpcParams, type RpcCall, type RpcHandler } from '@graycode/contracts';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import type { PlatformApplication } from '../../../apps/server/src/application';

// 编译此文件时同时验证界面调用和服务端返回值，函数不执行外部操作。
function contractTypes(call: RpcCall) {
  void call('settings.get').then(snapshot => { const revision: number = snapshot.revision; return revision; });
  void call('computer.observe', { windowId: '123', screenshot: true }).then(value => value.screenshot?.width);
  // @ts-expect-error 窗口标识必须保持跨端字符串形式。
  void call('computer.observe', { windowId: 123 });
  // @ts-expect-error 动作需要观察和调用身份。
  void call('computer.action', { action: 'click', x: 1, y: 2 });
  // @ts-expect-error 文件检查不能漏掉工作区。
  void call('files.inspect', { path: 'a.txt' });
  // @ts-expect-error 已迁移接口不接受拼错的方法名。
  void call('files.insepct', { workspaceId: 'w', path: 'a.txt' });
  // @ts-expect-error 文件列表处理器必须返回目录项，而不是一组字符串。
  const wrong: RpcHandler<'files.list'> = async () => ['a.txt'];
  return wrong;
}
void contractTypes;

test.each([
  ['computer.observe', { windowId: 123 }],
  ['computer.action', { observationId: 'frame', operationId: 'op', action: 'click', x: NaN }],
  ['browser.layout', { x: 0, y: 0, width: 100, height: 100, visible: 'true' }],
  ['files.upload', { workspaceId: 'w', path: 'a.txt', expectedVersion: 'v', bytes: [1, 2] }],
  ['settings.save', { settings: {}, expectedRevision: '1' }],
  ['approvals.resolve', { id: 'approval', accepted: 'false' }],
])('%s 的无效参数在传输边界被拒绝', (method, params) => {
  expect(() => validateRpcParams(method, params)).toThrow('参数');
});

test('服务端入口在执行之前检查契约，合法上传字节保持原样', async () => {
  const upload = jest.fn().mockResolvedValue({ path: 'a.txt' });
  const app = { actor: () => ({ id: 'owner' }), fileActions: { upload } } as unknown as PlatformApplication;
  const router = new ApplicationRouter(app), session = { actorId: 'owner', clientId: 'fixture' };
  await expect(router.call(session, 'files.upload', { workspaceId: 'w', path: 'a.txt', expectedVersion: 'v', bytes: [1] })).rejects.toThrow('bytes');
  expect(upload).not.toHaveBeenCalled();
  const bytes = new Uint8Array([0, 127, 255]);
  await router.call(session, 'files.upload', { workspaceId: 'w', path: 'a.txt', expectedVersion: 'v', bytes });
  expect(upload).toHaveBeenCalledWith('owner', 'w', 'a.txt', 'v', bytes);
  expect(() => validateRpcParams('runs.list', {})).not.toThrow();
  expect(() => validateRpcParams('computer.observe', { windowId: '123', screenshot: false, width: undefined })).not.toThrow();
});
