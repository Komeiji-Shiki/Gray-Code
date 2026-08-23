import { afterEach, describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import Tooltip from '../Tooltip.vue'
import IconButton from '../IconButton.vue'
import CustomSelect from '../CustomSelect.vue'
import CustomCheckbox from '../CustomCheckbox.vue'
import CustomSwitch from '../CustomSwitch.vue'
import Modal from '../Modal.vue'

const mountedWrappers: Array<{ unmount: () => void }> = []

function remember<T extends { unmount: () => void }>(wrapper: T): T {
  mountedWrappers.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mountedWrappers.length > 0) mountedWrappers.pop()?.unmount()
  document.body.innerHTML = ''
})

describe('common accessibility primitives', () => {
  test('Tooltip exposes its visible content as the slotted IconButton accessible name', async () => {
    const Host = defineComponent({
      components: { Tooltip, IconButton },
      template: `
        <Tooltip content="Attach file">
          <IconButton icon="codicon-attach" />
        </Tooltip>
      `
    })
    const wrapper = remember(mount(Host, { attachTo: document.body }))
    const button = wrapper.get('button')

    expect(button.attributes('aria-label')).toBe('Attach file')
    await button.trigger('focusin')
    await nextTick()
    expect(wrapper.get('[role="tooltip"]').text()).toContain('Attach file')
  })

  test('CustomSelect declares combobox/listbox/option relationships and restores trigger focus', async () => {
    const wrapper = remember(mount(CustomSelect, {
      attachTo: document.body,
      props: {
        modelValue: 'a',
        ariaLabel: 'Model',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' }
        ]
      }
    }))
    const trigger = wrapper.get('.select-trigger')

    expect(trigger.attributes('role')).toBe('combobox')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    const listbox = wrapper.get('[role="listbox"]')
    expect(trigger.attributes('aria-controls')).toBe(listbox.attributes('id'))
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2)

    await wrapper.get('.custom-select').trigger('keydown', { key: 'ArrowDown' })
    await wrapper.get('.custom-select').trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['b'])
    expect(document.activeElement).toBe(trigger.element)
  })

  test('Modal uses its title as the dialog name and labels the close button', async () => {
    remember(mount(Modal, {
      attachTo: document.body,
      props: { modelValue: true, title: 'Details' },
      slots: { default: '<p>Body</p>' }
    }))
    await nextTick()

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')
    const title = document.body.querySelector<HTMLElement>('.modal-title')
    const close = document.body.querySelector<HTMLButtonElement>('.modal-close')
    expect(dialog).not.toBeNull()
    expect(title).not.toBeNull()
    expect(dialog?.getAttribute('aria-labelledby')).toBe(title?.id)
    expect(close?.getAttribute('aria-label')).toBe('关闭')
  })

  test('CustomCheckbox links its hint and CustomSwitch exposes native switch state', async () => {
    const checkbox = remember(mount(CustomCheckbox, {
      props: { modelValue: false, ariaLabel: 'Feature', hint: 'Extra details' }
    }))
    const checkboxInput = checkbox.get('input')
    const hint = checkbox.get('.checkbox-hint')
    expect(checkboxInput.attributes('aria-label')).toBe('Feature')
    expect(checkboxInput.attributes('aria-describedby')).toBe(hint.attributes('id'))

    const switchWrapper = remember(mount(CustomSwitch, {
      props: { modelValue: false, ariaLabel: 'Streaming' }
    }))
    const switchInput = switchWrapper.get('input')
    expect(switchInput.attributes('role')).toBe('switch')
    expect(switchInput.attributes('aria-checked')).toBe('false')
    await switchInput.setValue(true)
    expect(switchWrapper.emitted('update:modelValue')?.[0]).toEqual([true])
  })
})
