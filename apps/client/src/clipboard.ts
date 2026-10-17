/**
 * 外壳剪贴板复制。
 *
 * 局域网 HTTP 直连不是安全上下文，`navigator.clipboard` 在这些页面里是 undefined；
 * 此时回退到临时 textarea + execCommand，保证文件树复制路径等操作可用。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('clipboard API 复制失败，尝试 execCommand 回退:', error);
  }

  const textarea = document.createElement('textarea');
  try {
    textarea.value = text;
    // 移出可视区域，避免页面跳动，同时保留可选中状态。
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    // 恢复用户原有选区，避免复制破坏正在进行的文本选择。
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return copied;
  } catch (error) {
    console.error('execCommand 复制失败:', error);
    return false;
  } finally {
    textarea.remove();
  }
}
