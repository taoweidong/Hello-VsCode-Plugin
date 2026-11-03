import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import VToolbar from '../../../webview/ui/VToolbar.vue'
import VToolbarDivider from '../../../webview/ui/VToolbarDivider.vue'
import VButton from '../../../webview/ui/VButton.vue'

/** 工具栏（此前零覆盖）：group 角色 / aria-label 透传 / 分隔符渲染。 */
describe('VToolbar / VToolbarDivider', () => {
  it('role=group + aria-label 透传（R-U-8：不用 toolbar 角色）', () => {
    const wrapper = mount({
      components: { VToolbar, VButton },
      template: `
        <VToolbar label="服务器操作">
          <VButton icon="plug">连接</VButton>
        </VToolbar>`,
    })
    const group = wrapper.find('[role="group"]')
    expect(group.exists()).toBe(true)
    expect(group.attributes('aria-label')).toBe('服务器操作')
    expect(group.find('button').exists()).toBe(true)
  })

  it('未传 label 时不输出 aria-label', () => {
    const wrapper = mount(VToolbar)
    expect(wrapper.attributes('aria-label')).toBeUndefined()
  })

  it('VToolbarDivider：分隔符语义（separator 角色 + 纵向方向）', () => {
    const wrapper = mount(VToolbarDivider)
    expect(wrapper.element.tagName).toBe('SPAN')
    expect(wrapper.attributes('role')).toBe('separator')
    expect(wrapper.attributes('aria-orientation')).toBe('vertical')
  })
})
