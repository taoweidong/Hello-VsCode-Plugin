import { expect, test } from 'playwright/test'
import { fieldControl, expectLastSentType, lastSent, loadPage, sendHost, sent } from './helpers'

/**
 * 任务管理（taskManager）E2E：上部查询参数 + 下部数据表格 + 分页 + 增删改查。
 *
 * 消息字段以 src/webview/protocol.ts 为准：
 * init{schema}（TASK_FIELD_DEFS 派生字面量的内联副本，与宿主派生逻辑的一致性由
 * 单测 taskManagerApp.spec 锁定）→ taskListRequest → taskList{page} → submit{draft}
 * → submitAck → taskList；失败 error（err.field 定位弹框控件）；taskDelete。
 */
const SCHEMA = [
  {
    key: 'name',
    label: '任务名称',
    type: 'text',
    required: true,
    maxLength: 64,
    placeholder: '如 主干每日构建（打桩规则：含 fail 模拟失败）',
  },
  {
    key: 'branch',
    label: '分支名',
    type: 'text',
    required: true,
    maxLength: 128,
    placeholder: '如 release/1.2.0',
  },
  {
    key: 'buildType',
    label: '构建类型',
    type: 'select',
    defaultValue: 'full',
    options: [
      { value: 'full', label: '完整构建' },
      { value: 'incremental', label: '增量构建' },
    ],
  },
  { key: 'notes', label: '备注', type: 'textarea', placeholder: '选填，随任务提交给服务端' },
]

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  name: '任务甲',
  branch: 'release/1.0.0',
  buildType: 'full',
  status: 'running',
  progress: 42,
  createdAt: '2026-10-25T00:00:00.000Z',
  ...overrides,
})

/** 新增 / 编辑弹框内的「保存」按钮（避免命中查询区按钮）。 */
const dialogSave = (page: import('playwright/test').Page) =>
  page.locator('.task-dialog__footer').getByRole('button', { name: '保存' })

test.beforeEach(async ({ page }) => {
  await loadPage(page, 'taskManager')
  await sendHost(page, { type: 'init', page: 'taskManager', schema: SCHEMA, value: {} })
})

test('taskManager：init 后渲染查询区与表格，空列表展示空态', async ({ page }) => {
  await expect(page.locator('.task-filters')).toBeVisible()
  await expect(page.locator('.task-table')).toBeVisible()
  // init 后页面自动请求第一页
  await expectLastSentType(page, 'taskListRequest')

  await sendHost(page, {
    type: 'taskList',
    page: { items: [], total: 0, page: 1, pageSize: 10 },
  })
  await expect(page.getByText('暂无任务')).toBeVisible()
  await expect(page.locator('.task-pagination__info')).toContainText('第 1 / 1 页')
})

test('taskManager：设计系统样式实际生效 + 主区占满面板（95% 宽度要求）', async ({ page }) => {
  // CSS 收集链断裂时页面退化为裸文本（v2.1.1 实测事故）：main.ts 漏 import tokens.css
  // → 全部 var(--ui-*) 落空 → 卡片无边框、宽度约束消失。锁定三个可观测效果：
  const viewportWidth = page.viewportSize()?.width ?? 1280
  const mainWidth = await page
    .locator('.app-shell__main--full')
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(
    mainWidth,
    '主区应占面板宽度 95% 左右（full 变体 + 内边距；裸文本/窄宽度变体均不满足）'
  ).toBeGreaterThan(viewportWidth * 0.9)
  const cardBorderStyle = await page
    .locator('.task-table-card')
    .evaluate((el) => getComputedStyle(el).borderTopStyle)
  expect(cardBorderStyle, '表格卡片边框应生效').toBe('solid')
  // 上下结构：查询区与表格区均渲染
  await expect(page.locator('.task-filters')).toBeVisible()
  await expect(page.locator('.task-table')).toBeVisible()
})

test('taskManager：查询区条件拼接进 taskListRequest', async ({ page }) => {
  const keywordInput = page.locator('.task-filters input').first()
  await keywordInput.fill('主干')
  await page.getByRole('button', { name: '查询' }).click()
  await expectLastSentType(page, 'taskListRequest')
  const sent = await lastSent(page)
  expect(sent).toMatchObject({
    query: { page: 1, pageSize: 10, keyword: '主干' },
  })
})

test('taskManager：新建任务 → submit 草稿正确（含默认构建类型）', async ({ page }) => {
  await page.getByRole('button', { name: '新建任务' }).click()
  await expect(page.locator('.task-dialog')).toBeVisible()
  await fieldControl(page, '任务名称').fill('主干每日构建')
  await fieldControl(page, '分支名').fill('release/2.0.0')
  await fieldControl(page, '备注').fill('e2e 提交')
  await dialogSave(page).click()

  const sent = await lastSent(page)
  expect(sent).toMatchObject({
    type: 'submit',
    draft: {
      name: '主干每日构建',
      branch: 'release/2.0.0',
      buildType: 'full',
      notes: 'e2e 提交',
    },
  })
  // 提交中：弹框保持打开（等待 taskList 落定后再关）
  await expect(page.locator('.task-dialog')).toBeVisible()
})

test('taskManager：taskList 渲染表格与状态；error 反馈定位弹框字段', async ({ page }) => {
  await sendHost(page, {
    type: 'taskList',
    page: { items: [makeTask()], total: 1, page: 1, pageSize: 10 },
  })
  await expect(page.getByText('任务甲')).toBeVisible()
  await expect(page.getByText('release/1.0.0')).toBeVisible()
  await expect(page.locator('.task-table').getByText('运行中')).toBeVisible()
  await expect(page.locator('.task-pagination__info')).toContainText('第 1 / 1 页 · 共 1 条')

  // 空必填：主按钮本地校验拦截，不发 submit（P2-F2，对齐 serialConsole）
  await page.getByRole('button', { name: '新建任务' }).click()
  await fieldControl(page, '任务名称').fill('   ')
  await dialogSave(page).click()
  await expect(page.locator('.v-form-field__error').first()).toHaveText('请填写「任务名称」')
  await expect(page.locator('.task-dialog')).toBeVisible()
  const submitCount = (await sent(page)).filter((message) => message.type === 'submit').length
  expect(submitCount).toBe(0)

  // 宿主错误路径（本地校验通过后宿主拒绝）：error.field 定位任务名称控件 + 反馈条
  await fieldControl(page, '任务名称').fill('fail 用例')
  await fieldControl(page, '分支名').fill('dev')
  await dialogSave(page).click()
  await sendHost(page, { type: 'error', message: '任务名称不能为空。', field: 'name' })
  await expect(page.locator('.task-feedback')).toHaveText('任务名称不能为空。')
  await expect(page.locator('.v-form-field__error').first()).toBeVisible()
})

test('taskManager：提交落定（submitAck）关闭弹框；taskList 应答不误关', async ({ page }) => {
  await page.getByRole('button', { name: '新建任务' }).click()
  await fieldControl(page, '任务名称').fill('任务乙')
  await fieldControl(page, '分支名').fill('dev')
  await dialogSave(page).click()
  // 列表应答先落定（宿主重查 / 轮询应答同型）：弹框保持打开（关框只认 submitAck）
  await sendHost(page, {
    type: 'taskList',
    page: {
      items: [makeTask({ name: '任务乙', branch: 'dev', status: 'queued', progress: 0 })],
      total: 1,
      page: 1,
      pageSize: 10,
    },
  })
  await expect(page.locator('.task-dialog')).toBeVisible()
  await sendHost(page, { type: 'submitAck', ok: true })
  await expect(page.locator('.task-dialog')).toBeHidden()
  await expect(page.locator('.task-feedback')).toHaveText('任务已保存。')
  // 落定后列表含 queued 任务 → 轮询接管刷新（页面发出 taskListRequest）
  await expectLastSentType(page, 'taskListRequest')
})

test('taskManager：删除任务 → 两段式布防确认 → taskDelete 并刷新列表为空态', async ({ page }) => {
  // 删除为破坏性操作：页内两段式布防确认（首点布防，3s 内再点执行），
  // 不依赖浏览器模态（webview 沙箱下 confirm 恒被忽略，第五轮评估 P0）
  await sendHost(page, {
    type: 'taskList',
    page: { items: [makeTask()], total: 1, page: 1, pageSize: 10 },
  })
  await expect(page.getByText('任务甲')).toBeVisible()

  await page.locator('.task-row__actions').getByRole('button', { name: '删除任务' }).click()
  // 首点仅布防：不发 taskDelete，按钮进入确认态
  await expect(
    page.locator('.task-row__actions').getByRole('button', { name: '再次点击确认删除' })
  ).toBeVisible()
  await page.locator('.task-row__actions').getByRole('button', { name: '再次点击确认删除' }).click()

  await expect
    .poll(
      async () => (await sent(page)).filter((message) => message.type === 'taskDelete').length,
      { timeout: 5_000 }
    )
    .toBe(1)
  const deletes = (await sent(page)).filter((message) => message.type === 'taskDelete')
  expect(deletes[deletes.length - 1]).toMatchObject({ type: 'taskDelete', id: 'task-1' })

  // 删除后宿主重新查询（沿用当前查询条件）
  await expectLastSentType(page, 'taskListRequest')
  await sendHost(page, {
    type: 'taskList',
    page: { items: [], total: 0, page: 1, pageSize: 10 },
  })
  await expect(page.getByText('暂无任务')).toBeVisible()
})
