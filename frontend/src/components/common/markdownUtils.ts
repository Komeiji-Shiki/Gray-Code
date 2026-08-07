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
        // 例外：GrayCode 代码块工具栏按钮（fence 渲染器生成，class 受控：
        // code-tool-btn + code-copy-btn/code-wrap-btn）。不放行则默认渲染路径下
        // 复制/换行按钮被净化移除，代码块无法复制。其余 button 照旧移除。
        const isCodeToolbarBtn =
          tagName === 'button' &&
          el.classList.contains('code-tool-btn')
        if (!isCodeToolbarBtn) {
          el.remove()
          return
        }
      }

      // 剥离危险属性：事件处理器、危险协议（javascript:/vbscript:/data:）、
      // srcdoc、style（可携带 url()/expression 脚本）、SVG use 的外部引用
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value

        if (name.startsWith('on')) {
          el.removeAttribute(name)
          continue
        }

        // srcdoc 可在 iframe 上下文执行 HTML；style 可携带 url(javascript:)/expression()/behavior
        if (name === 'srcdoc' || name === 'style') {
          el.removeAttribute(name)
          continue
        }

        // SVG <use> 的 href/xlink:href 仅允许同文档 fragment 引用（#...），
        // 其余（外部 URL、data: 等）一律剥离，防止加载外部/内联 SVG 载荷
        if (tagName === 'use' && (name === 'href' || name === 'xlink:href')) {
          if (!value.startsWith('#')) {
            el.removeAttribute(name)
          }
          continue
        }

        // 可能携带 URL 的属性：href/src/action/formaction + SVG 的 xlink:href/poster
        const isUrlAttr =
          name === 'href' || name === 'src' || name === 'action' ||
          name === 'formaction' || name === 'xlink:href' || name === 'poster'
        if (isUrlAttr) {
          // 先剔除控制字符，防止 "java\nscript:" / "jav&#0;ascript:" 之类混淆绕过
          const normalized = value.replace(/[\u0000-\u001F\u007F]/g, '')
          // javascript:/vbscript:/data: 协议一律剥离
          if (/^\s*(?:javascript|vbscript|data):/i.test(normalized)) {
            // 例外：图片类 src 放行 data:image/*（保持 markdown 内嵌图片能力；
            // <img> 加载 SVG 时脚本被禁用，不会执行）
            const isImageDataSrc =
              name === 'src' &&
              /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif);/i.test(normalized.trim())
            if (!isImageDataSrc) {
              el.removeAttribute(name)
            }
          }
        }

        // srcset（<img>/<source> 响应式候选列表）：按逗号拆分为候选
        // （每个候选为 "URL [descriptor]"），逐个校验 URL 协议——仅放行
        // http/https、data:image/*（与上方 src 白名单一致）及无协议相对
        // 路径（如 "a.jpg 1x, b.jpg 2x"），剥离 javascript:/vbscript:/data: 候选
        if (name === 'srcset') {
          const keptCandidates: string[] = []
          for (const rawCandidate of value.split(',')) {
            const candidate = rawCandidate.trim()
            if (!candidate) continue
            // URL 为候选首段（首个空白之前），先剔除控制字符防协议混淆
            const urlPart = candidate.split(/\s+/)[0].replace(/[\u0000-\u001F\u007F]/g, '')
            const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(urlPart)
            const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : ''
            const isImageDataSrc =
              /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|avif);/i.test(urlPart)
            if (scheme === '' || scheme === 'http' || scheme === 'https' || isImageDataSrc) {
              keptCandidates.push(candidate)
            }
          }
          if (keptCandidates.length > 0) {
            el.setAttribute(name, keptCandidates.join(', '))
          } else {
            el.removeAttribute(name)
          }
        }
        continue
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
