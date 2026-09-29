// 模态框的接收顺序独立于当前焦点，焦点被移除时仍只操作最上层。
const stack: symbol[] = []
export function pushModal(id: symbol) { removeModal(id); stack.push(id) }
export function removeModal(id: symbol) { const index = stack.indexOf(id); if (index >= 0) stack.splice(index, 1) }
export function isTopModal(id: symbol) { return stack[stack.length - 1] === id }
