import { app, dialog, shell } from 'electron';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { showDesktopConfirmation } from './desktopDialog';
import { t, getActualLanguage } from '../../../backend/i18n';
import { redactDiagnostic } from '../../../shared/diagnosticText';

export function dataDirectoryArguments(args: string[], directory: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--data') { index++; continue; }
    if (!args[index].startsWith('--data=')) result.push(args[index]);
  }
  return [...result, '--data', directory];
}

/** 恢复入口只安排下一次启动，原数据和迁移记录保持可恢复。 */
export async function recoverStartup(error: unknown, restart: (args?: string[]) => Promise<void>): Promise<void> {
  const detail = redactDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error));
  const logs = app.getPath('logs');
  await mkdir(logs, { recursive: true }).then(() => appendFile(path.join(logs, 'startup.log'), `${new Date().toISOString()}\n${detail}\n`)).catch(() => {});
  for (;;) {
    const action = await showDesktopConfirmation({ language: getActualLanguage(), title: t('desktop.shell.startupFailed'), message: t('desktop.shell.startupFailed'),
      detail: `${t('desktop.shell.startupDetail')}\n\n${detail}`, cancelId: 'close', actions: [
        { id: 'close', label: t('desktop.shell.close') }, { id: 'logs', label: t('desktop.shell.openLogs') },
        { id: 'directory', label: t('desktop.shell.chooseData') }, { id: 'retry', label: t('desktop.shell.retry'), kind: 'primary' },
      ] });
    if (action === 'close') return;
    if (action === 'logs') { const failure = await shell.openPath(logs); if (failure) dialog.showErrorBox('GrayCode', failure); continue; }
    if (action === 'retry') { await restart(); return; }
    const selected = await dialog.showOpenDialog({ title: t('desktop.shell.chooseData'), properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled || !selected.filePaths[0]) continue;
    await restart(dataDirectoryArguments(process.argv.slice(1), selected.filePaths[0])); return;
  }
}
