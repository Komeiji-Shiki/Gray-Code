import { afterEach, describe, expect, it } from 'vitest'
import { lockBodyScroll, unlockBodyScroll } from '../../utils/bodyScrollLock'

describe('bodyScrollLock', () => {
  afterEach(() => {
    unlockBodyScroll()
    unlockBodyScroll()
    document.body.style.overflow = ''
  })

  it('keeps scrolling locked until every overlay releases its lock', () => {
    document.body.style.overflow = 'auto'
    lockBodyScroll()
    lockBodyScroll()

    unlockBodyScroll()
    expect(document.body.style.overflow).toBe('hidden')

    unlockBodyScroll()
    expect(document.body.style.overflow).toBe('auto')
  })
})
