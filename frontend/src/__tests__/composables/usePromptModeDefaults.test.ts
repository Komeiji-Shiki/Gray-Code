import { describe, expect, vi } from 'vitest'
import {
  CODE_MODE_TEMPLATE,
  DEFAULT_DYNAMIC_CONTEXT_TEMPLATE
} from '@shared/defaultPromptTemplates'

vi.mock('@/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

import { usePromptModeDefaults } from '../../composables/usePromptModeDefaults'

describe('usePromptModeDefaults', () => {
  test('uses the same code and dynamic defaults as the extension host', () => {
    const defaults = usePromptModeDefaults()

    expect(defaults.CODE_MODE_TEMPLATE).toBe(CODE_MODE_TEMPLATE)
    expect(defaults.DEFAULT_TEMPLATE).toBe(CODE_MODE_TEMPLATE)
    expect(defaults.DEFAULT_DYNAMIC_TEMPLATE).toBe(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE)
  })
})
