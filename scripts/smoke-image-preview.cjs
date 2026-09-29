const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');

/** 使用真实图片、布局和查看器，覆盖大图缩小后偏出画布的问题。 */
module.exports = async function verifyImagePreview({ window, evaluate, ui, until, root, output }) {
  const previousSize = window.getSize(), previousMinimum = window.getMinimumSize();
  const image = nativeImage.createFromPath(path.join(root, 'resources/icon.png')).resize({ width: 1600, height: 1200 });
  assert(!image.isEmpty());
  try {
    await ui('previewAttachment', { name: 'large-image-layout.png', mimeType: 'image/png', data: image.toPNG().toString('base64') });
    await until(() => evaluate('!!document.querySelector(".content-preview img.ready")'), 'attachment image loaded');
    window.setMinimumSize(320, 500);
    for (const width of [900, 420, 360]) {
      window.setSize(width, 850);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      for (const rotation of [0, 90]) {
        if (rotation) await evaluate(`document.querySelector('.preview-tools button[aria-label="向右旋转"]').click()`);
        await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
        const view = await evaluate(`(() => {
          const bounds = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width }; };
          return { width:innerWidth, image:bounds('.preview-stage img'), stage:bounds('.preview-stage'), title:bounds('.content-preview header strong'),
            controls:Array.from(document.querySelectorAll('.content-preview header button,.content-preview header a')).map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right};}) };
        })()`);
        assert(view.title.width > 80, `${width}px 下文件名可见`);
        assert(Math.abs((view.image.left + view.image.right) / 2 - (view.stage.left + view.stage.right) / 2) < 2, `${width}px 图片水平居中`);
        assert(Math.abs((view.image.top + view.image.bottom) / 2 - (view.stage.top + view.stage.bottom) / 2) < 2, `${width}px 图片垂直居中`);
        assert(view.image.left >= view.stage.left - 2 && view.image.right <= view.stage.right + 2, `${width}px 图片在画布宽度内`);
        assert(view.image.top >= view.stage.top - 2 && view.image.bottom <= view.stage.bottom + 2, `${width}px 图片在画布高度内`);
        assert(view.controls.every(control => control.left >= 0 && control.right <= view.width), `${width}px 操作按钮在窗口内`);
        if (rotation) await evaluate(`document.querySelector('.preview-tools button[aria-label="向左旋转"]').click()`);
      }
      if (width === 420) await fs.writeFile(path.join(output, 'image-preview-narrow.png'), (await window.webContents.capturePage()).toPNG());
    }
  } finally {
    await evaluate('document.querySelector(".content-preview .preview-close")?.click()');
    window.setMinimumSize(...previousMinimum); window.setSize(...previousSize);
  }
};
