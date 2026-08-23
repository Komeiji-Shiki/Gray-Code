import type { PromptContextItem } from '../../../types/promptContext'
import { t } from '../../../i18n'

export interface ChipHandlers {
  onRemove: (id: string) => void
  onMouseEnter: (ctx: PromptContextItem) => void
  onMouseLeave: () => void
  onClick: (ctx: PromptContextItem) => void
}

/**
 * Single entry-point for building a context "chip" DOM node.
 * Keeping this in one place prevents drift between render/insert paths.
 */
export function createContextChipElement(
  ctx: PromptContextItem,
  iconClass: string,
  handlers: ChipHandlers
): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.className = 'context-chip'
  chip.contentEditable = 'false'
  chip.dataset.contextId = ctx.id
  chip.setAttribute('role', 'group')
  chip.setAttribute('aria-label', ctx.title)

  const icon = document.createElement('i')
  icon.className = iconClass
  icon.setAttribute('aria-hidden', 'true')
  chip.appendChild(icon)

  const title = document.createElement('span')
  title.className = 'context-chip__text'
  title.textContent = ctx.title
  title.tabIndex = 0
  title.setAttribute('role', 'button')
  title.setAttribute('aria-label', ctx.title)
  const openContext = (event: Event) => {
    event.stopPropagation()
    handlers.onClick(ctx)
  }
  title.onclick = openContext
  title.onkeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openContext(event)
  }
  chip.appendChild(title)

  const removeBtn = document.createElement('button')
  removeBtn.className = 'context-chip__remove'
  removeBtn.type = 'button'
  removeBtn.setAttribute('aria-label', `${t('common.remove')}: ${ctx.title}`)
  removeBtn.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>'
  removeBtn.onclick = (e) => {
    e.stopPropagation()
    handlers.onRemove(ctx.id)
  }
  chip.appendChild(removeBtn)

  chip.onmouseenter = () => handlers.onMouseEnter(ctx)
  chip.onmouseleave = () => handlers.onMouseLeave()
  chip.onclick = (e) => {
    e.stopPropagation()
    handlers.onClick(ctx)
  }

  return chip
}
