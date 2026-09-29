export interface DesktopDialogAction { id: string; label: string; kind?: 'primary' | 'danger' }
export interface DesktopDialogContent {
  title: string;
  language?: string;
  message: string;
  detail?: string;
  items?: string[];
  actions: DesktopDialogAction[];
  cancelId?: string;
  progress?: string;
  colors?: Record<string, string>;
}
export function escapeDialogText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
/** 自定义颜色只接受十六进制字面值，不能进入样式或 HTML 语法。 */
export function desktopDialogHtml(content: DesktopDialogContent): string {
  const escape = escapeDialogText;
  const palette = { background: '#17191e', panel: '#22252c', text: '#dedee3', muted: '#969ba6', accent: '#6ba6ff', border: '#323742', danger: '#f08080' };
  const variables = Object.entries(palette).map(([key, value]) => `--${key}:${/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(content.colors?.[key] ?? '') ? content.colors![key] : value}`).join(';');
  return `<!doctype html><html lang="${escape(content.language ?? 'zh-CN')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escape(content.title)}</title><style>
*{box-sizing:border-box}html{${variables};color-scheme:dark light}body{margin:0;height:100vh;background:var(--background);color:var(--text);font:14px/1.65 "Segoe UI","Microsoft YaHei","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;border:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}header{display:flex;align-items:center;gap:10px;padding:13px 20px;border-bottom:1px solid var(--border);-webkit-app-region:drag;font-size:12px;color:var(--muted)}header strong{font-size:14px;color:var(--text);letter-spacing:.03em}header span:last-child{margin-left:auto}.brand{width:23px;height:23px;border:1px solid var(--accent);display:grid;place-items:center;color:var(--accent);font-weight:700}main{flex:1;min-height:0;overflow:auto;padding:25px 28px}h1{font-size:23px;line-height:1.4;font-weight:600;margin:0 0 12px;letter-spacing:-.02em}p{margin:0 0 16px;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere}ul{list-style:none;margin:16px 0 0;padding:12px 15px;background:var(--panel);border-left:2px solid var(--accent)}li+li{margin-top:7px}li:before{content:'·';color:var(--accent);font-weight:700;margin-right:10px}footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding:16px 22px;border-top:1px solid var(--border)}button{font:inherit;font-size:13px;min-height:36px;padding:7px 16px;border:1px solid var(--border);border-radius:2px;background:var(--panel);color:var(--text);cursor:pointer}button:hover{filter:brightness(1.15)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button.primary{border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}#progress{margin-top:24px;color:var(--text);display:flex;gap:12px;align-items:center;min-height:30px}.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;flex:none}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-color:var(--accent)}}
li{overflow-wrap:anywhere}header span:last-child{max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}footer{flex-shrink:0}@media(forced-colors:active){body,main,header,footer,ul,button{background:Canvas;color:CanvasText;border-color:ButtonText}button:focus-visible{outline-color:Highlight}.spinner{border-color:ButtonText}}
</style></head><body role="dialog" aria-modal="true" aria-labelledby="message" aria-describedby="detail"><header><b class="brand" aria-hidden="true">G</b><strong>GrayCode</strong><span>${escape(content.title)}</span></header>
<main tabindex="-1"><h1 id="message">${escape(content.message)}</h1><p id="detail">${escape(content.detail ?? '')}</p>
${content.items?.length ? `<ul>${content.items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
${content.progress !== undefined ? `<div id="progress" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span><span id="progress-label">${escape(content.progress)}</span></div>` : ''}</main>
${content.actions.length ? `<footer>${content.actions.map(action => `<button type="button" class="${action.kind ?? ''}" data-dialog-action="${escape(action.id)}"${action.id === content.cancelId ? ' data-dialog-cancel="true" autofocus' : ''}>${escape(action.label)}</button>`).join('')}</footer>` : ''}</body></html>`;
}
