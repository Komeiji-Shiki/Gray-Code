import { DesktopSaveAll } from '../../../apps/desktop/src/saveAll';

afterEach(() => jest.useRealTimers());
test('保存退出只接受当前窗口的两个不同参与者回执，失败阻止退出', async () => {
  const saves = new DesktopSaveAll(); let id = '';
  let completed = false;
  const pending = saves.request(1, value => { id = value; }).then(() => { completed = true; });
  saves.complete(2, { requestId: id, participant: 'documents' });
  saves.complete(1, { requestId: id, participant: 'settings' });
  saves.complete(1, { requestId: id, participant: 'settings' });
  await Promise.resolve(); expect(completed).toBe(false);
  saves.complete(1, { requestId: id, participant: 'documents' }); await pending;
  const failure = expect(saves.request(1, value => { id = value; })).rejects.toThrow('file.ts');
  saves.complete(1, { requestId: id, participant: 'documents', error: 'file.ts: conflict' });
  saves.complete(1, { requestId: id, participant: 'settings' }); await failure;
});
test('失联的编辑界面使保存失败，下一次保存可以重新开始', async () => {
  jest.useFakeTimers(); const saves = new DesktopSaveAll();
  const timeout = expect(saves.request(1, () => {})).rejects.toThrow('超时');
  jest.advanceTimersByTime(30_000); await timeout;
  let id = ''; const next = saves.request(1, value => { id = value; });
  saves.complete(1, { requestId: id, participant: 'documents' });
  saves.complete(1, { requestId: id, participant: 'settings' }); await next;
});
