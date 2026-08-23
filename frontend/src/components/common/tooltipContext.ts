import type { InjectionKey, Ref } from 'vue'

/**
 * Tooltip content shared with slotted controls so the visible hint also becomes
 * their accessible name without duplicating the string at every call site.
 */
export const TOOLTIP_CONTENT_KEY: InjectionKey<Readonly<Ref<string | undefined>>> = Symbol('graycode-tooltip-content')
