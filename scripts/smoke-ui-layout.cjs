// 真实 Chromium 布局检查：jsdom 的组件测试不能覆盖 flex 固有宽度和伪元素几何。
const assert = require('node:assert/strict');

async function verifyChatLayout(chat) {
  const result = await chat(`(${function () {
    const check = (value, label) => { if (!value) throw new Error(`Chat layout: ${label}`); };
    const users = [...document.querySelectorAll('.user-message')];
    const cards = [...document.querySelectorAll('.tool-item')];
    check(users.length > 0 && cards.length > 0, 'actual messages and tool cards exist');
    for (const user of users) {
      const parent = user.parentElement, style = getComputedStyle(parent), rect = user.getBoundingClientRect();
      const available = parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      check(Math.abs(rect.width - available) <= 1, `user message fills ${available}px (actual ${rect.width}px)`);
      check(getComputedStyle(user).marginLeft === '0px' && getComputedStyle(user).marginRight === '0px', 'user message has no side margins');
    }
    const widths = [760, 320, 240];
    for (const card of cards) {
      const description = card.querySelector('.tool-description'), name = card.querySelector('.tool-name');
      const originalStyle = card.getAttribute('style'), originalText = description?.textContent;
      try {
        if (description) description.textContent = 'frontend/src/components/tools/automation/__tests__/very-long-file-name.test.ts; '.repeat(24);
        for (const width of widths) {
          card.style.width = `${width}px`;
          const header = card.querySelector('.tool-header'), summary = card.querySelector('.tool-summary');
          const rect = header.getBoundingClientRect(), nameRect = name.getBoundingClientRect();
          check(getComputedStyle(name).whiteSpace === 'nowrap', `${width}px tool name stays on one line`);
          check(name.scrollWidth <= name.clientWidth + 1, `${width}px builtin tool name is not squeezed`);
          check(header.scrollWidth <= header.clientWidth + 1, `${width}px header does not overflow`);
          check(summary.scrollWidth <= summary.clientWidth + 1, `${width}px summary does not overflow`);
          check(nameRect.left >= rect.left - 1 && nameRect.right <= rect.right + 1, `${width}px tool name stays inside header`);
          for (const action of card.querySelectorAll('.tool-action-buttons button')) {
            const actionRect = action.getBoundingClientRect();
            check(actionRect.width > 0 && actionRect.left >= rect.left - 1 && actionRect.right <= rect.right + 1, `${width}px action stays visible`);
          }
        }
      } finally {
        if (originalStyle === null) card.removeAttribute('style'); else card.setAttribute('style', originalStyle);
        if (description) description.textContent = originalText;
      }
    }
    // 分类与消息身份由组件回归覆盖；用真实节点验证连接样式没有内部空白。
    const fixture = document.createElement('div');
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;display:flex;flex-direction:column';
    fixture.setAttribute('aria-hidden', 'true');
    try {
      for (const position of ['start', 'middle', 'end']) {
        const item = users[0].cloneNode(true);
        item.removeAttribute('data-message-id');
        for (const node of [item, ...item.querySelectorAll('[id]')]) node.removeAttribute('id');
        for (const name of [...item.classList]) if (name.startsWith('message-input-group')) item.classList.remove(name);
        item.classList.add('message-input-group', `message-input-group-${position}`);
        fixture.append(item);
      }
      document.body.append(fixture);
      const nodes = [...fixture.children];
      for (let index = 1; index < nodes.length; index++) {
        const previous = nodes[index - 1].getBoundingClientRect(), current = nodes[index].getBoundingClientRect();
        check(Math.abs(current.top - previous.bottom) <= 1, 'connected input rows have no internal gap');
        check(Math.abs(current.width - 320) <= 1 && Math.abs(previous.width - 320) <= 1, 'connected input rows remain full width');
        check(getComputedStyle(nodes[index]).borderTopLeftRadius === '0px', 'only outer group corners are rounded');
      }
    } finally { fixture.remove(); }
    return { userMessages: users.length, toolCards: cards.length, widths, inputGroupGeometry: true };
  }.toString()})();`);
  assert(result.userMessages > 0 && result.toolCards > 0);
  return result;
}

async function verifySelectionMarker(run, selector) {
  const result = await run(`(${function (selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Selection marker missing: ${selector}`);
    const style = getComputedStyle(node, '::before');
    return { width: style.width, height: parseFloat(style.height), actualHeight: node.getBoundingClientRect().height,
      left: style.left, top: style.top, bottom: style.bottom, radius: style.borderRadius,
      pointerEvents: style.pointerEvents, position: style.position, shadow: getComputedStyle(node).boxShadow };
  }.toString()})(${JSON.stringify(selector)});`);
  assert.equal(result.width, '2px', selector);
  assert.equal(result.radius, '0px', selector);
  assert.equal(result.position, 'absolute', selector);
  assert.equal(result.pointerEvents, 'none', selector);
  assert.equal(result.shadow, 'none', selector);
  assert.equal(result.left, '0px', selector);
  assert.equal(result.top, '0px', selector);
  assert.equal(result.bottom, '0px', selector);
  assert(Math.abs(result.height - result.actualHeight) <= 1, `${selector}: full-height straight line`);
}

async function verifyCheckboxLayout(chat) {
  const result = await chat(`(${function () {
    const mark = document.querySelector('.thinking-backfill-section .custom-checkbox input:checked ~ .checkmark');
    if (!mark) throw new Error('Checked channel checkbox missing');
    const originalStyle = mark.getAttribute('style'), sizes = [14, 16];
    try {
      for (const size of sizes) {
        mark.style.width = `${size}px`; mark.style.height = `${size}px`;
        const style = getComputedStyle(mark, '::after');
        if (Math.abs(parseFloat(style.left) - mark.clientWidth / 2) > 0.6 || Math.abs(parseFloat(style.top) - mark.clientHeight / 2) > 0.6)
          throw new Error(`${size}px checkbox tick is not centered`);
        if (style.display !== 'block' || style.width !== '4px' || style.height !== '8px' || style.boxSizing !== 'content-box')
          throw new Error(`${size}px checkbox tick geometry changed`);
        const transform = new DOMMatrixReadOnly(style.transform);
        if (Math.abs(transform.a - Math.SQRT1_2) > 0.001 || Math.abs(transform.b - Math.SQRT1_2) > 0.001)
          throw new Error(`${size}px checkbox tick angle changed`);
      }
    } finally {
      if (originalStyle === null) mark.removeAttribute('style'); else mark.setAttribute('style', originalStyle);
    }
    return sizes;
  }.toString()})();`);
  assert.deepEqual(result, [14, 16]);
}

module.exports = { verifyChatLayout, verifySelectionMarker, verifyCheckboxLayout };
