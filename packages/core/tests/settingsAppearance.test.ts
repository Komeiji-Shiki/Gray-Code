import { PlatformApplication } from '../../../apps/server/src/application';
import { DEFAULT_UI_FONT } from '../../../shared/appearance';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication;
beforeEach(async () => { f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data }); });
afterEach(async () => { await app.close(); await f.cleanup(); });

test('新设置默认使用藏青外壳与新默认界面字体', () => {
  const { appearance } = app.settings.read('appearance');
  expect(appearance.darkPalette).toBe('shell');
  expect(appearance.uiFont).toBe(DEFAULT_UI_FONT);
});

test('保存接受三种深色配色与缺省值，拒绝未知配色', async () => {
  for (const darkPalette of ['graphite', 'indigo', undefined] as const) {
    const snapshot = app.settings.snapshot();
    snapshot.settings.appearance.darkPalette = darkPalette;
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    expect(app.settings.read('appearance').appearance.darkPalette).toBe(darkPalette);
  }
  const snapshot = app.settings.snapshot();
  (snapshot.settings.appearance as { darkPalette?: string }).darkPalette = 'neon';
  await expect(app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision })).rejects.toThrow('Invalid appearance settings.');
});
