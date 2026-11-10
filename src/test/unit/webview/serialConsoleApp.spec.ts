import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import App from '../../../webview/apps/serialConsole/App.vue'
import { __setVsCodeApiForTest } from '../../../webview/shared/useVsCodeApi'
import { deriveFormSchema, toFieldDefs } from '../../../webview/formSchema'
import { SERVER_FIELD_DEFS } from '../../../extension/features/serialConsole/serverSchema'
import type { FieldDef, SerialServerWire } from '../../../webview/protocol'
import { createHostApiMock, hostMessage, inputValue } from './appTestUtils'

/**
 * 串口控制台页面：init 装配 / 服务器管理与保存（密码剥离）/ 连接与发送（本地回显）/
 * 实时输出 / 历史交互（填入与删除）/ 两段式删除 / 检测串口 chips。
 */

const SCHEMA: FieldDef[] = toFieldDefs(deriveFormSchema(SERVER_FIELD_DEFS))

function makeServer(overrides: Partial<SerialServerWire> = {}): SerialServerWire {
  return {
    id: 'srv-1',
    name: '服务器甲',
    serialPath: 'COM3',
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    lineEnding: 'lf',
    autoLogin: false,
    username: '',
    description: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function createApiMock(initialState: unknown = undefined) {
  // 第五轮基建：mock 实现收敛到 appTestUtils（替代本文件手写双轨版本）
  return createHostApiMock(initialState)
}

function sendInit(extra: Record<string, unknown> = {}): void {
  hostMessage({
    type: 'init',
    page: 'serialConsole',
    schema: SCHEMA,
    value: null,
    extra: { servers: [makeServer()], history: [], ...extra },
  })
}

let api: ReturnType<typeof createApiMock>
let wrapper: VueWrapper | undefined

beforeEach(() => {
  api = createApiMock()
  __setVsCodeApiForTest(api)
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  __setVsCodeApiForTest(undefined)
})

const postedTypes = (): string[] =>
  (api.posted as { type?: string }[]).map((message) => String(message.type))

describe('serialConsole 页面：装配与连接', () => {
  it('挂载即上报 ready；init 后渲染服务器列表 / 状态条 / 空输出', async () => {
    wrapper = mount(App)
    expect(postedTypes()).toEqual(['ready'])
    sendInit()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('服务器甲')
    expect(wrapper.text()).toContain('COM3 · 115200')
    expect(wrapper.text()).toContain('未连接')
    expect(wrapper.find('.console-output__scroll').text()).toContain('暂无输出')
  })

  it('initialServerId 触发自动连接（serialConnect）', async () => {
    wrapper = mount(App)
    sendInit({ initialServerId: 'srv-1' })
    await wrapper.vm.$nextTick()
    const connect = (api.posted as { type?: string; serverId?: string }[]).find(
      (message) => message.type === 'serialConnect'
    )
    expect(connect).toMatchObject({ serverId: 'srv-1' })
  })

  it('serialState 连接后：状态条 ON；断开回 OFF', async () => {
    wrapper = mount(App)
    sendInit()
    hostMessage({ type: 'serialState', serverId: 'srv-1', state: 'connected' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('已连接：服务器甲')
    hostMessage({ type: 'serialState', serverId: 'srv-1', state: 'disconnected' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('未连接')
  })

  it('连接错误：状态条出错并以回显块展示错误信息', async () => {
    wrapper = mount(App)
    sendInit()
    hostMessage({ type: 'serialState', serverId: 'srv-1', state: 'error', error: 'COM3 被占用' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('连接出错')
    expect(wrapper.find('.console-output__scroll').text()).toContain('COM3 被占用')
  })
})

describe('serialConsole 页面：命令下发与输出', () => {
  async function connect(): Promise<void> {
    sendInit()
    hostMessage({ type: 'serialState', serverId: 'srv-1', state: 'connected' })
    await wrapper!.vm.$nextTick()
  }

  it('serialData 批次渲染到输出区（按到达顺序）', async () => {
    wrapper = mount(App)
    await connect()
    hostMessage({ type: 'serialData', seq: 1, text: 'Ubuntu 22.04\n' })
    hostMessage({ type: 'serialData', seq: 2, text: '$ ' })
    await wrapper.vm.$nextTick()
    const blocks = wrapper.findAll('.console-output__block')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text()).toContain('Ubuntu 22.04')
    expect(blocks[1].element.textContent).toContain('$ ')
  })

  it('输出超上限裁剪最旧块（MAX_OUTPUT_BLOCKS，防长会话内存膨胀）', async () => {
    wrapper = mount(App)
    await connect()
    const total = 2001 // 上限 2000 + 1：恰好触发一次最旧块裁剪
    for (let index = 0; index < total; index += 1) {
      hostMessage({ type: 'serialData', seq: index + 1, text: `block-${index}\n` })
    }
    await wrapper.vm.$nextTick()
    const blocks = wrapper.findAll('.console-output__block')
    expect(blocks).toHaveLength(2000)
    expect(blocks[0].text()).toContain('block-1') // block-0 最旧，已被裁掉
    expect(blocks[1999].text()).toContain('block-2000')
    expect(wrapper.find('.console-output__scroll').text()).not.toContain('block-0\n')
  })

  it('Enter 发送：post serialSend + 本地回显 > 命令', async () => {
    wrapper = mount(App)
    await connect()
    const input = wrapper.find('input[placeholder^="输入命令"]')
    await input.setValue('show version')
    await input.trigger('keydown', { key: 'Enter' })
    const send = (api.posted as { type?: string; command?: string }[]).find(
      (message) => message.type === 'serialSend'
    )
    expect(send).toMatchObject({ command: 'show version' })
    expect(wrapper.find('.console-output__scroll').text()).toContain('> show version')
    expect(inputValue(input.element)).toBe('')
  })

  it('未连接时发送按钮禁用', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const sendButton = wrapper.findAll('button').find((button) => button.text().includes('发送'))
    expect(sendButton?.attributes('disabled')).toBeDefined()
  })
})

describe('serialConsole 页面：服务器管理', () => {
  it('编辑：表单回填服务器字段', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const editButton = wrapper.findAll('.server-list__actions button')[1]
    await editButton.trigger('click')
    const nameInput = wrapper.find('input[placeholder="如：服务器甲"]')
    expect(inputValue(nameInput.element)).toBe('服务器甲')
    expect(wrapper.text()).toContain('编辑服务器')
  })

  it('P2-B4：密码输入以掩码渲染（type=password），值仍可提交给宿主单独携带', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const passwordInput = wrapper.find('input[placeholder="选填"]')
    expect(passwordInput.attributes('type')).toBe('password')
    // 必填字段一并填写，让保存路径走通（本用例验证的是掩码渲染不改变提交语义）
    await wrapper.find('input[placeholder="如：服务器甲"]').setValue('新服务器')
    await wrapper.find('input[placeholder^="如 COM3"]').setValue('COM7')
    await passwordInput.setValue('s3cret')
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存服务器'))
    await saveButton?.trigger('click')
    const save = (api.posted as { type?: string; password?: string }[]).find(
      (message) => message.type === 'serialServerSave'
    )
    expect(save?.password).toBe('s3cret')
  })

  it('P2-F3：编辑态 Esc 重置两段式布防——首键布防保持编辑，再键确认复位', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const editButton = wrapper.findAll('.server-list__actions button')[1]
    await editButton.trigger('click')
    expect(wrapper.text()).toContain('编辑服务器')

    // P0 守护：webview 沙箱下浏览器模态 confirm 恒被忽略，页面不得依赖它
    const confirmSpy = vi.spyOn(
      (globalThis as unknown as { window: { confirm: (message?: string) => boolean } }).window,
      'confirm'
    )

    // 首次 Esc：仅布防，保持编辑态，重置按钮进入确认态
    await wrapper.find('form').trigger('keydown', { key: 'Escape' })
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('编辑服务器')
    expect(
      wrapper.findAll('button').find((button) => button.text().includes('确认重置'))
    ).toBeDefined()

    // 再次 Esc（限时内）：确认复位为新增态
    await wrapper.find('form').trigger('keydown', { key: 'Escape' })
    expect(wrapper.text()).toContain('新增服务器')
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('保存：post serialServerSave（密码单独携带）；servers 推送后表单复位', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const nameInput = wrapper.find('input[placeholder="如：服务器甲"]')
    await nameInput.setValue('新服务器')
    const pathInput = wrapper.find('input[placeholder^="如 COM3"]')
    await pathInput.setValue('COM7')
    const passwordInput = wrapper.find('input[placeholder="选填"]')
    await passwordInput.setValue('s3cret')
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存服务器'))
    await saveButton?.trigger('click')
    const save = (
      api.posted as { type?: string; draft?: Record<string, unknown>; password?: string }[]
    ).find((message) => message.type === 'serialServerSave')
    expect(save).toBeDefined()
    expect(save?.draft).toMatchObject({ name: '新服务器', serialPath: 'COM7' })
    expect(save?.draft && 'password' in save.draft).toBe(false)
    expect(save?.password).toBe('s3cret')

    hostMessage({
      type: 'serialServers',
      servers: [makeServer({ name: '新服务器', serialPath: 'COM7' })],
    })
    await wrapper.vm.$nextTick()
    expect(inputValue(nameInput.element)).toBe('')
  })

  it('校验错误：error(field) 定位到表单错误行；继续输入清除', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存服务器'))
    await saveButton?.trigger('click')
    hostMessage({ type: 'error', message: '名称不能为空。', field: 'name' })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('名称不能为空。')
    const nameInput = wrapper.find('input[placeholder="如：服务器甲"]')
    await nameInput.setValue('甲')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('名称不能为空。')
  })

  it('保存失败后：外部 servers 推送不清空编辑态（awaitingSaveReset 泄漏防护）', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const editButton = wrapper.findAll('.server-list__actions button')[1]
    await editButton.trigger('click')
    await wrapper.find('input[placeholder="如：服务器甲"]').setValue('改动名')
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存修改'))
    await saveButton?.trigger('click')

    // 保存失败回 error(field)：awaitingSaveReset 必须同步清除
    hostMessage({ type: 'error', message: '名称不能为空。', field: 'name' })
    await wrapper.vm.$nextTick()

    // 随后任意外部列表推送（如其他端变更）：不得误清当前编辑
    hostMessage({
      type: 'serialServers',
      servers: [makeServer(), makeServer({ id: 'srv-2', name: '服务器乙' })],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('编辑服务器')
    const nameInput = wrapper.find('input[placeholder="如：服务器甲"]')
    expect(inputValue(nameInput.element)).toBe('改动名')
  })

  it('两段式删除：首次布防、再次点击才 post serialServerDelete', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const deleteButton = wrapper.findAll('.server-list__delete')[0]
    await deleteButton.trigger('click')
    expect(postedTypes()).not.toContain('serialServerDelete')
    await deleteButton.trigger('click')
    const del = (api.posted as { type?: string; id?: string }[]).find(
      (message) => message.type === 'serialServerDelete'
    )
    expect(del).toMatchObject({ id: 'srv-1' })
  })

  it('检测串口：chips 渲染并点击填充串口字段', async () => {
    wrapper = mount(App)
    sendInit()
    await wrapper.vm.$nextTick()
    const detectButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('检测串口'))
    await detectButton?.trigger('click')
    expect(postedTypes()).toContain('serialPortsRequest')
    hostMessage({ type: 'serialPorts', ports: [{ path: 'COM9' }, { path: 'COM10' }] })
    await wrapper.vm.$nextTick()
    const chip = wrapper.find('.server-form__chip')
    expect(chip.text()).toBe('COM9')
    await chip.trigger('click')
    const pathInput = wrapper.find('input[placeholder^="如 COM3"]')
    expect(inputValue(pathInput.element)).toBe('COM9')
  })
})

describe('serialConsole 页面：历史命令', () => {
  it('历史渲染（MRU 序）；单击填入输入框；删除单条 post commandHistoryRemove', async () => {
    wrapper = mount(App)
    sendInit({
      history: [
        { id: 'h1', command: 'ls -l', lastUsedAt: 2, useCount: 3 },
        { id: 'h2', command: 'show version', lastUsedAt: 1, useCount: 1 },
      ],
    })
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.history-panel__row')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('ls -l')
    expect(rows[0].text()).toContain('×3')

    await rows[1].trigger('click')
    const input = wrapper.find('input[placeholder^="输入命令"]')
    expect(inputValue(input.element)).toBe('show version')

    await wrapper.find('.history-panel__remove').trigger('click')
    const remove = (api.posted as { type?: string; id?: string }[]).find(
      (message) => message.type === 'commandHistoryRemove'
    )
    expect(remove).toMatchObject({ id: 'h1' })
  })

  it('搜索过滤历史；两段式清空 post commandHistoryClear', async () => {
    wrapper = mount(App)
    sendInit({
      history: [
        { id: 'h1', command: 'ls -l', lastUsedAt: 2, useCount: 1 },
        { id: 'h2', command: 'show version', lastUsedAt: 1, useCount: 1 },
      ],
    })
    await wrapper.vm.$nextTick()
    const search = wrapper.find('input[placeholder="搜索历史命令"]')
    await search.setValue('show')
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.history-panel__row')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('show version')

    const clearButton = wrapper
      .find('.history-panel__toolbar')
      .findAll('button')
      .find((button) => button.text().includes('清空'))
    await clearButton?.trigger('click')
    expect(postedTypes()).not.toContain('commandHistoryClear')
    await clearButton?.trigger('click')
    expect(postedTypes()).toContain('commandHistoryClear')
  })
})

describe('serialConsole 页面：保存竞态（17 方案阶段 1，P1-4）', () => {
  it('保存推送到达前切换编辑另一服务器：推送不清空新编辑表单', async () => {
    wrapper = mount(App)
    sendInit({ servers: [makeServer(), makeServer({ id: 'srv-2', name: '服务器乙' })] })
    await wrapper.vm.$nextTick()
    // 编辑 srv-1 并发起保存（在途）
    const editButtons = () => wrapper!.findAll('.server-list__actions button[title="编辑"]')
    await editButtons()[0]?.trigger('click')
    await wrapper.find('input[placeholder="如：服务器甲"]').setValue('甲改名')
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存修改'))
    await saveButton?.trigger('click')

    // 推送到达前：用户切换到编辑 srv-2（表单被替换为新对象）
    await editButtons()[1]?.trigger('click')
    await wrapper.vm.$nextTick()
    expect(inputValue(wrapper.find('input[placeholder="如：服务器甲"]').element)).toBe('服务器乙')

    // 自己的保存推送到达：不得把 srv-2 的编辑表单清空回新增态
    hostMessage({
      type: 'serialServers',
      servers: [makeServer({ name: '甲改名' }), makeServer({ id: 'srv-2', name: '服务器乙' })],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('编辑服务器')
    expect(inputValue(wrapper.find('input[placeholder="如：服务器甲"]').element)).toBe('服务器乙')
  })

  it('保存推送到达且表单未被切换：仍复位为新增态（既有语义保持）', async () => {
    wrapper = mount(App)
    sendInit({ servers: [makeServer()] })
    await wrapper.vm.$nextTick()
    const editButtons = wrapper.findAll('.server-list__actions button[title="编辑"]')
    await editButtons[0]?.trigger('click')
    await wrapper.find('input[placeholder="如：服务器甲"]').setValue('甲改名')
    const saveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('保存修改'))
    await saveButton?.trigger('click')
    hostMessage({ type: 'serialServers', servers: [makeServer({ name: '甲改名' })] })
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('编辑服务器')
    expect(inputValue(wrapper.find('input[placeholder="如：服务器甲"]').element)).toBe('')
  })
})
