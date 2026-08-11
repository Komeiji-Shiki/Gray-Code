/* 临时调试：CSS 括号平衡 + 渲染后按钮检查 */
import { renderRemoteControlUiHtml } from '../backend/modules/remoteControl/remoteControlUi';

test('tmp css braces + rendered buttons', async () => {
  const html = renderRemoteControlUiHtml('zh-CN');
  // 提取 <style> 内容检查括号平衡
  const sm = html.match(/<style>([\s\S]*?)<\/style>/);
  expect(sm).not.toBeNull();
  const css = sm![1];
  let depth = 0;
  let minDepth = 0;
  for (const ch of css) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
  }
  console.log('CSS_BRACE_END_DEPTH=' + depth + ' MIN=' + minDepth);
  // 检查 icon-btn / tab-add / panel-back-btn / ws-add 规则是否存在
  for (const sel of ['.icon-btn svg', '.tab-add svg', '.panel-back-btn svg', '#btn-ws-add svg', '#btn-ws-switch svg', '.icon-btn', '.panel-back-btn', '.tab-add']) {
    console.log('CSS_HAS_' + sel.replace(/[^A-Za-z0-9]/g, '_') + '=' + css.includes(sel));
  }
  // 渲染后 DOM 检查（jsdom 跑交互）
  const { JSDOM, VirtualConsole } = require('jsdom') as any;
  const vc = new VirtualConsole();
  const errors: unknown[] = [];
  vc.on('jsdomError', (e: unknown) => errors.push(e));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    virtualConsole: vc,
    beforeParse: (w: any) => {
      w.fetch = (url: string, init?: any) => {
        const path = String(url).split('?')[0];
        const data: any = { ok: true };
        if (path === '/api/status') data.appVersion = '1.7.10dev';
        if (path === '/api/settings') data.settings = {
          toolsConfig: { system_prompt: { modes: { code: { id: 'code', name: 'Code' } }, currentModeId: 'code' } },
          remoteControl: { enabled: true, port: 17532 }
        };
        if (path === '/api/configs') data.configs = [{ id: 'c1', name: 'A', type: 'openai', enabled: true }];
        if (path === '/api/prompt-modes') data.modes = [{ id: 'code', name: 'Code' }];
        if (path === '/api/conversations') { data.conversations = []; data.total = 0; data.hasMore = false; }
        if (path === '/api/messages') { data.messages = []; data.total = 0; }
        if (path === '/api/tools') { data.tools = []; data.autoExec = {}; }
        if (path === '/api/dependencies') data.dependencies = [];
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
      };
      w.EventSource = class { constructor() {} addEventListener() {} close() {} };
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const doc = dom.window.document;
  // 打开设置面板
  doc.querySelector('#btn-settings').click();
  await new Promise((r) => setTimeout(r, 150));
  const back = doc.querySelector('#btn-settings-back');
  console.log('BACK_BTN_SVG=' + (back && back.querySelector('svg') ? 'YES' : 'NO'));
  console.log('BACK_BTN_HTML=' + (back ? back.innerHTML.slice(0, 80) : 'NULL'));
  const tabAdd = doc.querySelector('.tab-add');
  console.log('TAB_ADD_SVG=' + (tabAdd && tabAdd.querySelector('svg') ? 'YES' : 'NO'));
  // 打开文件面板
  doc.querySelector('#btn-files').click();
  await new Promise((r) => setTimeout(r, 100));
  const wsAdd = doc.querySelector('#btn-ws-add');
  console.log('WS_ADD_SVG=' + (wsAdd && wsAdd.querySelector('svg') ? 'YES' : 'NO'));
  console.log('WS_ADD_HTML=' + (wsAdd ? wsAdd.innerHTML.slice(0, 80) : 'NULL'));
  const drawerNew = doc.querySelector('#btn-new');
  console.log('BTN_NEW_SVG=' + (drawerNew && drawerNew.querySelector('svg') ? 'YES' : 'NO'));
  console.log('ERRORS=' + errors.length);
  dom.window.close();
});
