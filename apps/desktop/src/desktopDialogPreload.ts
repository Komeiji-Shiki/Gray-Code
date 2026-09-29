/// <reference lib="dom" />
import { ipcRenderer } from 'electron';

// 对话框不暴露应用 RPC，也不执行页面脚本；只发送当前窗口允许的按钮标识。
window.addEventListener('DOMContentLoaded', () => {
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-dialog-action]:not(:disabled)'));
  const cancel = () => document.querySelector<HTMLButtonElement>('[data-dialog-cancel]');
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button[data-dialog-action]');
    if (button && !button.disabled) ipcRenderer.send('graycode:dialog-result', button.dataset.dialogAction);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel()?.click(); }
    if (event.key !== 'Tab') return;
    const targets = buttons();
    if (!targets.length) { event.preventDefault(); return; }
    const index = targets.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === targets.length - 1) {
      event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus();
    }
  });
  (cancel() ?? buttons()[0] ?? document.querySelector<HTMLElement>('main'))?.focus();
});
ipcRenderer.on('graycode:dialog-progress', (_event, text: unknown) => {
  const label = document.getElementById('progress-label');
  if (label && typeof text === 'string') label.textContent = text;
});
