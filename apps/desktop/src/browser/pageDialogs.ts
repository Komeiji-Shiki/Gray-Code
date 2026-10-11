/** Electron 覆盖了主世界的 prompt；独立 CDP 世界仍提供 Chromium 原生同步实现。 */
export function nativePromptScripts(eventName: string): { isolated: string; main: string } {
  const event = JSON.stringify(eventName);
  return {
    isolated: `(() => {
      const nativePrompt = window.prompt.bind(window);
      document.addEventListener(${event}, event => {
        const request = event.target;
        if (request?.tagName !== 'SPAN' || !request.hasAttribute('data-graycode-prompt')) return;
        event.stopImmediatePropagation();
        const answer = nativePrompt(request.getAttribute('message'), request.getAttribute('default'));
        request.setAttribute('answer', JSON.stringify(answer));
      }, true);
    })()`,
    main: `(() => {
      const original = window.prompt;
      // 只替换 Electron contextBridge 的匿名原生代理，网站定义的 prompt 保持原样。
      if (typeof original !== 'function' || original.name !== '' || !/\\[native code\\]/.test(Function.prototype.toString.call(original))) return;
      window.prompt = function prompt(message = '', defaultValue = '') {
        const request = document.createElement('span');
        request.hidden = true;
        request.setAttribute('data-graycode-prompt', '');
        request.setAttribute('message', String(message));
        request.setAttribute('default', String(defaultValue));
        // DOM 事件跨世界同步派发，原生 prompt 返回后再把 string/null 交回网页调用方。
        // 请求节点只在调用期间存在，保持隐藏并在 finally 移除，不参与页面快照或长期状态。
        const root = document.documentElement;
        if (!root) throw new Error('prompt 调用时页面文档尚未建立。');
        root.appendChild(request);
        try {
          request.dispatchEvent(new Event(${event}, { bubbles: true }));
          const answer = request.getAttribute('answer');
          if (answer === null) throw new Error('原生 prompt 尚未准备完成。');
          return JSON.parse(answer);
        } finally { request.remove(); }
      };
    })()`,
  };
}
