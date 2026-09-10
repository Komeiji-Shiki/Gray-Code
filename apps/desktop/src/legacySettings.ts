import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { parse, type ParseError } from 'jsonc-parser';
import type { PlatformApplication } from '../../server/src/application';
import { SettingsTransfer } from '../../server/src/settings/transfer';

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('旧设置文件过大。');
    const errors: ParseError[] = [];
    const value = parse(await readFile(file, 'utf8'), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('旧设置文件存在语法错误。');
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** 只复制旧配置；旧 VS Code 文件、数据库和聊天存档均不修改。 */
export async function migrateLegacySettings(application: PlatformApplication, appData: string) {
  if (await application.storage.getRecord('configuration-migrations', 'vscode')) return;
  if (application.settings.snapshot().settings.providers.length) return;
  for (const product of ['Code', 'Code - Insiders', 'VSCodium', 'Cursor']) {
    const user = path.join(appData, product, 'User');
    const values = await readJson(path.join(user, 'settings.json')) ?? {};
    const vscodeSettings = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('graycode.')));
    let channels: unknown[] = [];
    const databasePath = path.join(user, 'globalStorage', 'state.vscdb');
    try {
      await stat(databasePath);
      const database = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1000 });
      try {
        const row = database.prepare('SELECT value FROM ItemTable WHERE lower(key)=?').get('komeiji-shiki.graycode') as { value: string } | undefined;
        if (row) { const state = JSON.parse(row.value); const configs = state['graycode.configs']; if (configs && typeof configs === 'object') channels = Object.values(configs); }
      } finally { database.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!channels.length && !Object.keys(vscodeSettings).length) continue;
    const draft = await application.product.draft();
    const hasSavedPreferences = !!await application.storage.getRecord('product-settings', 'main');
    const result = await new SettingsTransfer(application).import(draft, { version: '1.0', vscodeSettings: hasSavedPreferences ? {} : vscodeSettings, channelConfigs: channels });
    if (!result.success) throw new Error(result.errors.join('；'));
    if (!result.imported.channelConfigs && !result.imported.vscodeSettings) continue;
    await application.product.save(draft);
    await application.storage.putRecord({ namespace: 'configuration-migrations', id: 'vscode', value: {
      source: product, importedAt: Date.now(), channels: result.imported.channelConfigs, preferences: result.imported.vscodeSettings,
    } });
    return;
  }
}
