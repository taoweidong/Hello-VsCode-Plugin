import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDraftCommands } from '../../../extension/commands/draftCommands'
import { COMMAND } from '../../../extension/constants'
import { Uri, __resetStubs, __stubs, type ActiveTextEditorStub } from '../stubs/vscode'
import type { DraftBoxService } from '../../../extension/features/drafts/draftBoxService'

/**
 * 草稿箱命令组（此前 draftFile / draftFolder 单测与集成均零覆盖）：
 * 8 条右键入口 → 4 个命令的上下文提取与分支路由，用 Fake DraftBoxService
 * 锁定「宿主如何拿到编辑器 / 资源管理器上下文」这条教学链路。
 */

/** 命令注册记录器：key → 回调。 */
function makeRegistrar() {
  const registered = new Map<string, (...args: unknown[]) => unknown>()
  const register = (commandId: string, callback: (...args: unknown[]) => unknown): void => {
    registered.set(commandId, callback)
  }
  return { registered, register }
}

/** DraftBoxService 测试替身：只记录调用，不触碰 fs。 */
function makeFakeDrafts(fileUri: unknown) {
  const calls: { method: string; args: unknown[] }[] = []
  const fake = {
    fileUri,
    list: vi.fn(() => [{ title: '最新草稿' }]),
    addSelection: vi.fn(async (text: string, source: string) => {
      calls.push({ method: 'addSelection', args: [text, source] })
      return 1
    }),
    appendToLatest: vi.fn(async (text: string, source: string) => {
      calls.push({ method: 'appendToLatest', args: [text, source] })
      return true
    }),
    addFile: vi.fn(async (uri: unknown) => {
      calls.push({ method: 'addFile', args: [uri] })
      return 1
    }),
    addFiles: vi.fn(async (uris: readonly unknown[]) => {
      calls.push({ method: 'addFiles', args: [uris] })
      return uris.length
    }),
    addFolder: vi.fn(async (uri: unknown) => {
      calls.push({ method: 'addFolder', args: [uri] })
      return 1
    }),
  }
  return { fake, drafts: fake as unknown as DraftBoxService, calls }
}

function setSelection(text: string, fileName = 'main.ts'): void {
  const editor: ActiveTextEditorStub = {
    document: {
      uri: Uri.file(`/work/${fileName}`),
      fileName: `/work/${fileName}`,
      getText: () => text,
    },
    selection: {},
  }
  __stubs.activeTextEditor = editor
}

function lastInfoMessage(): string | undefined {
  const entry = __stubs.recorded.filter((item) => item.kind === 'showInformationMessage').at(-1)
  return entry ? (entry.args[0] as { message: string }).message : undefined
}

function lastErrorMessage(): string | undefined {
  const entry = __stubs.recorded.filter((item) => item.kind === 'showErrorMessage').at(-1)
  return entry ? (entry.args[0] as { message: string }).message : undefined
}

let registrar: ReturnType<typeof makeRegistrar>
let drafts: ReturnType<typeof makeFakeDrafts>

beforeEach(() => {
  __resetStubs()
  registrar = makeRegistrar()
  drafts = makeFakeDrafts(Uri.file('/work/.vscode/ext-starter.drafts.json'))
  registerDraftCommands(registrar.register, { drafts: drafts.drafts })
})

describe('draftSelection（编辑器右键：登记选中文本）', () => {
  it('无工作区：提示不可用，不调用服务', () => {
    registerDraftCommands(registrar.register, { drafts: makeFakeDrafts(undefined).drafts })
    setSelection('内容')
    registrar.registered.get(COMMAND.draftSelection)?.()
    expect(lastInfoMessage()).toContain('未打开工作区')
    expect(drafts.fake.addSelection).not.toHaveBeenCalled()
  })

  it('无活动编辑器 / 空选区：提示没有选中文本', () => {
    registrar.registered.get(COMMAND.draftSelection)?.()
    expect(lastInfoMessage()).toContain('没有选中文本')

    setSelection('   ')
    registrar.registered.get(COMMAND.draftSelection)?.()
    expect(lastInfoMessage()).toContain('没有选中文本')
    expect(drafts.fake.addSelection).not.toHaveBeenCalled()
  })

  it('有选区：以全文与来源文件名登记', async () => {
    setSelection('  要登记的代码  ', 'app.ts')
    registrar.registered.get(COMMAND.draftSelection)?.()
    await vi.waitFor(() => {
      expect(drafts.fake.addSelection).toHaveBeenCalledWith('  要登记的代码  ', 'app.ts')
    })
  })

  it('服务抛错：走 showError（不裸 reject）', async () => {
    drafts.fake.addSelection.mockRejectedValueOnce(new Error('磁盘已满'))
    setSelection('内容')
    registrar.registered.get(COMMAND.draftSelection)?.()
    await vi.waitFor(() => {
      expect(lastErrorMessage()).toBe('磁盘已满')
    })
  })
})

describe('appendDraftSelection（追加到最近草稿）', () => {
  it('无工作区：返回 no-workspace 诊断对象', () => {
    registerDraftCommands(registrar.register, { drafts: makeFakeDrafts(undefined).drafts })
    expect(registrar.registered.get(COMMAND.appendDraftSelection)?.()).toMatchObject({
      ok: false,
      reason: 'no-workspace',
    })
  })

  it('无选区：返回 no-selection 诊断对象（含 scheme）', () => {
    // 有编辑器但选区为空白：activeScheme 读取活动文档 scheme
    setSelection('   ')
    expect(registrar.registered.get(COMMAND.appendDraftSelection)?.()).toMatchObject({
      ok: false,
      reason: 'no-selection',
      activeScheme: 'file',
    })
  })

  it('无活动编辑器：no-selection 且 scheme 为 null', () => {
    expect(registrar.registered.get(COMMAND.appendDraftSelection)?.()).toMatchObject({
      ok: false,
      reason: 'no-selection',
      activeScheme: null,
    })
  })

  it('追加成功：返回 { ok, appended } 并提示目标草稿标题', async () => {
    setSelection('追加内容')
    const result = (await registrar.registered.get(COMMAND.appendDraftSelection)?.()) as {
      ok: boolean
      appended: boolean
    }
    expect(result).toEqual({ ok: true, appended: true })
    await vi.waitFor(() => {
      expect(lastInfoMessage()).toContain('已追加到「最新草稿」')
    })
  })

  it('服务抛错：不裸 reject，返回失败原因', async () => {
    drafts.fake.appendToLatest.mockRejectedValueOnce(new Error('文件被占用'))
    setSelection('内容')
    const result = (await registrar.registered.get(COMMAND.appendDraftSelection)?.()) as {
      ok: boolean
      reason: string
    }
    expect(result).toEqual({ ok: false, reason: '文件被占用' })
  })
})

describe('draftFile（编辑器 / 资源管理器右键登记文件）', () => {
  it('多选批量：uris 数组（>1）走 addFiles，非 Uri 项被过滤', async () => {
    const uriA = Uri.file('/work/a.ts')
    const uriB = Uri.file('/work/b.ts')
    registrar.registered.get(COMMAND.draftFile)?.(uriA, [uriA, uriB, 'bad'])
    await vi.waitFor(() => {
      expect(drafts.fake.addFiles).toHaveBeenCalledWith([uriA, uriB])
    })
  })

  it('单选：第一个参数为 Uri 走 addFile', async () => {
    const uri = Uri.file('/work/single.ts')
    registrar.registered.get(COMMAND.draftFile)?.(uri)
    await vi.waitFor(() => {
      expect(drafts.fake.addFile).toHaveBeenCalledWith(uri)
    })
  })

  it('编辑器侧：无参数时登记当前活动文件', async () => {
    setSelection('ignored', 'editor-open.ts')
    registrar.registered.get(COMMAND.draftFile)?.()
    await vi.waitFor(() => {
      expect(drafts.fake.addFile).toHaveBeenCalledWith(Uri.file('/work/editor-open.ts'))
    })
  })

  it('无参数且无编辑器：提示没有可登记的文件', () => {
    registrar.registered.get(COMMAND.draftFile)?.()
    expect(lastInfoMessage()).toContain('没有可登记的文件')
  })

  it('服务抛错：以 err.message 提示（文件不可访问场景）', async () => {
    drafts.fake.addFile.mockRejectedValueOnce(new Error('文件不存在'))
    registrar.registered.get(COMMAND.draftFile)?.(Uri.file('/work/gone.ts'))
    await vi.waitFor(() => {
      expect(lastInfoMessage()).toBe('文件不存在')
    })
  })
})

describe('draftFolder（资源管理器右键：文件夹汇总）', () => {
  it('无参数：提示从资源管理器右键调用', () => {
    registrar.registered.get(COMMAND.draftFolder)?.()
    expect(lastInfoMessage()).toContain('资源管理器')
  })

  it('有 Uri：登记文件夹；抛错以 err.message 提示', async () => {
    const uri = Uri.file('/work/src')
    registrar.registered.get(COMMAND.draftFolder)?.(uri)
    await vi.waitFor(() => {
      expect(drafts.fake.addFolder).toHaveBeenCalledWith(uri)
    })

    drafts.fake.addFolder.mockRejectedValueOnce(new Error('文件夹内没有文件，无可登记内容。'))
    registrar.registered.get(COMMAND.draftFolder)?.(uri)
    await vi.waitFor(() => {
      expect(lastInfoMessage()).toContain('无可登记内容')
    })
  })

  it('非 Uri 参数：提示从资源管理器右键调用', () => {
    registrar.registered.get(COMMAND.draftFolder)?.('not-a-uri')
    expect(lastInfoMessage()).toContain('资源管理器')
  })
})
