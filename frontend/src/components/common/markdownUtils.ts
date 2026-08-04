/**
 * markdownUtils - MarkdownRenderer 共享纯函数
 *
 * 从 MarkdownRenderer.vue 抽取，避免每个消息块实例重复定义，
 * 同时便于对纯逻辑（正则、转义）编写单元测试。
 */

/**
 * 转义 HTML 特殊字符（& < > " '）
 * 用于将不可信文本安全地插入 HTML 属性/文本节点
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * 仅渲染 LaTeX 时使用的行内公式正则（renderLatexOnly）
 *
 * 护栏：
 * - (?<!\$) 前面不能是 $（避免匹配 $$ 的第二个 $）
 * - (?!\$)  后面不能是 $（避免匹配 $$ 的第一个 $）
 * - (?!\s)  后面不能是空白（避免 $ 100 这种货币金额）
 * - (?<!\s) 前面不能是空白（避免首尾空白被当公式内容）
 *
 * 与 markdownItKatex 插件内的 mathInline 规则对齐
 */
export const RENDER_LATEX_ONLY_INLINE_RE =
  /(?<!\$)\$(?!\$)(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$(?!\$)/g

/**
 * 仅渲染 LaTeX 时使用的块级公式正则
 */
export const RENDER_LATEX_ONLY_BLOCK_RE = /\$\$([\s\S]*?)\$\$/g

/**
 * 对 html:true 模式下 markdown-it 的输出做最小净化，
 * 移除可直接执行脚本的标签/属性/协议，其余 HTML 保留。
 *
 * 使用浏览器原生 DOM 解析（template 元素），不会下载/执行资源。
 */

// 攻击者可用 ASCII tab/换行等控制字符混入 scheme 名绕过正则匹配
// （WHATWG URL 解析器在解析 scheme 时会剥离这些字符），这里先统一剔除再匹配。
function stripSchemeControlChars(value: string): string {
  return value.replace(/[\t\n\r\f ]+/g, '')
}

// URL scheme 白名单：
// - href: 仅 http/https/mailto/tel（data: 可触发 webview 导航，禁止）
// - src: 仅 http/https/data:（data: 仅允许 image 类型，避免 SVG/HTML 执行）
function isSafeHrefScheme(value: string): boolean {
  const cleaned = stripSchemeControlChars(value)
  return /^(https?:\/\/|mailto:|tel:)/i.test(cleaned)
}

function isSafeSrcScheme(value: string): boolean {
  const cleaned = stripSchemeControlChars(value)
  if (/^https?:\/\//i.test(cleaned)) return true
  if (/^data:/i.test(cleaned)) {
    // 仅允许图片 data URI，阻止 text/html、image/svg+xml 等可执行类型
    return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico);/i.test(cleaned)
  }
  return false
}

export function sanitizeHtml(dirty: string): string {
  const template = document.createElement('template')
  template.innerHTML = dirty

  const walk = (node: Node): void => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const tagName = el.tagName.toLowerCase()

      // 移除危险元素（脚本、内嵌框架、表单控件、样式引入、meta 等）
      if ([
        'script', 'iframe', 'object', 'embed', 'form',
        'input', 'button', 'select', 'textarea',
        'link', 'meta', 'base', 'style'
      ].includes(tagName)) {
        el.remove()
        return
      }

      // 剥离危险属性：事件处理器、危险协议、可执行资源属性
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value

        if (name.startsWith('on')) {
          el.removeAttribute(name)
          continue
        }

        // xlink:href / href / srcset / formaction 等不受 href/src 白名单覆盖
        if (name === 'xlink:href' || name === 'srcset' || name === 'formaction') {
          el.removeAttribute(name)
          continue
        }

        if (name === 'href') {
          if (!isSafeHrefScheme(value)) {
            el.removeAttribute(name)
            continue
          }
          // 回写净化后的值：剥离 scheme 内控制字符，避免“视觉正常但点击被解析为危险 scheme”
          el.setAttribute(name, stripSchemeControlChars(value))
          continue
        }

        if (name === 'src' || name === 'action') {
          if (!isSafeSrcScheme(value)) {
            el.removeAttribute(name)
            continue
          }
          el.setAttribute(name, stripSchemeControlChars(value))
          continue
        }
      }
    }

    // 遍历子节点（拷贝一份避免遍历中删除导致跳过节点）
    for (const child of Array.from(node.childNodes)) {
      walk(child)
    }
  }

  walk(template.content)

  return template.innerHTML
}
