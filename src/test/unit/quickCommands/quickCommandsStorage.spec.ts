import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import {
  createQuickCommandsStore,
  JsonQuickCommandsStore,
  MementoQuickCommandsStore,
  QUICK_COMMANDS_FILE_NAME,
  QUICK_COMMANDS_MEMENTO_KEY,
  QUICK_COMMANDS_SCHEMA_VERSION,
  type QuickCommandsData,
} from '../../../extension/features/quickCommands/quickCommandsService'
import { __resetStubs, __stubs, createMementoStub, createExtensionContextStub } from '../stubs/vscode'

/**
 * 快捷命令双存储（v3.5，16 方案）：工作区 `.vscode/quick-commands.json`（信封 +
 * 原子写 + 损坏备份）与无工作区 Memento 回退；装配工厂按工作区有无二选一。
 */

let tmpRoot = ''

async function makeTmpWorkspace(): Promise<string> {
  const root = await nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'quick-commands-'))
  await nodeFs.promises.mkdir(nodePath.join(root, '.vscode'))
  return root
}

function setWorkspace(root: string): void {
  __stubs.workspaceFolders = [
    { uri: vscode.Uri.file(root), name: nodePath.basename(root), index: 0 },
  ]
}

function quickCommandsFileUri(root: string): vscode.Uri {
  return vscode.Uri.joinPath(
    vscode.Uri.file(root),
    ...QUICK_COMMANDS_FILE_NAME.split('/')
  )
}

const sampleData: QuickCommandsData = {
  groups: [{ id: 'g1', name: 'git', createdAt: '2026-01-01T00:00:00.000Z' }],
  commands: [
    {
      id: 'c1',
      name: 'push',
      command: 'git push origin main',
      groupId: 'g1',
      addedAt: '2026-01-02T00:00:00.000Z',
    },
  ],
}

describe('JsonQuickCommandsStore（工作区文件存储）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  afterEach(async () => {
    if (tmpRoot) {
      await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
  })

  it('save → load 往返：信封格式落盘且字段一致', async () => {
    tmpRoot = await makeTmpWorkspace()
    setWorkspace(tmpRoot)
    const store = new JsonQuickCommandsStore(quickCommandsFileUri(tmpRoot))
    await store.save(sampleData)
    const loaded = await store.load()
    expect(loaded).toEqual(sampleData)

    const onDisk = JSON.parse(
      await nodeFs.promises.readFile(quickCommandsFileUri(tmpRoot).fsPath, 'utf8')
    ) as Record<string, unknown>
    expect(onDisk.schemaVersion).toBe(QUICK_COMMANDS_SCHEMA_VERSION)
    expect(Object.keys(onDisk)).toEqual(['schemaVersion', 'groups', 'commands'])
  })

  it('文件不存在（首次使用）→ 空数据且不告警', async () => {
    tmpRoot = await makeTmpWorkspace()
    const warnings: string[] = []
    const store = new JsonQuickCommandsStore(quickCommandsFileUri(tmpRoot), {
      onWarning: (message) => warnings.push(message),
    })
    expect(await store.load()).toEqual<QuickCommandsData>({ groups: [], commands: [] })
    expect(warnings).toEqual([])
  })

  it('损坏 JSON → 复制 .corrupt-*.bak 备份后按空数据继续（Review Focus 1）', async () => {
    tmpRoot = await makeTmpWorkspace()
    setWorkspace(tmpRoot)
    const fileUri = quickCommandsFileUri(tmpRoot)
    await nodeFs.promises.writeFile(fileUri.fsPath, '{ 不是 JSON', 'utf8')
    const warnings: string[] = []
    const store = new JsonQuickCommandsStore(fileUri, {
      onWarning: (message) => warnings.push(message),
    })

    expect(await store.load()).toEqual<QuickCommandsData>({ groups: [], commands: [] })

    const dirEntries = await nodeFs.promises.readdir(nodePath.join(tmpRoot, '.vscode'))
    const backups = dirEntries.filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(
      await nodeFs.promises.readFile(nodePath.join(tmpRoot, '.vscode', backups[0]!), 'utf8')
    ).toBe('{ 不是 JSON')
    // 原文件保留在原位（favorites 同契约：绝无备份不覆盖）
    expect(await nodeFs.promises.readFile(fileUri.fsPath, 'utf8')).toBe('{ 不是 JSON')
    expect(warnings.join('\n')).toContain('损坏')
  })

  it('BOM 头宽容读取', async () => {
    tmpRoot = await makeTmpWorkspace()
    const fileUri = quickCommandsFileUri(tmpRoot)
    await nodeFs.promises.writeFile(
      fileUri.fsPath,
      `\uFEFF${JSON.stringify({ schemaVersion: 1, groups: [], commands: [] })}`,
      'utf8'
    )
    expect(await new JsonQuickCommandsStore(fileUri).load()).toEqual<QuickCommandsData>({
      groups: [],
      commands: [],
    })
  })

  it('根节点形状不符（顶层数组）→ 备份后按空数据继续', async () => {
    tmpRoot = await makeTmpWorkspace()
    const fileUri = quickCommandsFileUri(tmpRoot)
    await nodeFs.promises.writeFile(fileUri.fsPath, '["legacy"]', 'utf8')
    const warnings: string[] = []
    const store = new JsonQuickCommandsStore(fileUri, {
      onWarning: (message) => warnings.push(message),
    })
    expect(await store.load()).toEqual<QuickCommandsData>({ groups: [], commands: [] })
    expect(warnings.join('\n')).toContain('损坏')
  })
})

describe('MementoQuickCommandsStore（无工作区回退）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('save → load 往返（globalState）', async () => {
    const memento = createMementoStub()
    const store = new MementoQuickCommandsStore(memento, QUICK_COMMANDS_MEMENTO_KEY)
    await store.save(sampleData)
    expect(await store.load()).toEqual(sampleData)
    expect(memento.__backing.get(QUICK_COMMANDS_MEMENTO_KEY)).toEqual(sampleData)
  })

  it('损坏/缺失数据按守卫归一（缺省空数据）', async () => {
    const warnings: string[] = []
    const memento = createMementoStub({ [QUICK_COMMANDS_MEMENTO_KEY]: '不是对象' })
    const store = new MementoQuickCommandsStore(memento, QUICK_COMMANDS_MEMENTO_KEY, {
      onWarning: (message) => warnings.push(message),
    })
    expect(await store.load()).toEqual<QuickCommandsData>({ groups: [], commands: [] })
    expect(warnings.join('\n')).toContain('信封')
  })
})

describe('createQuickCommandsStore（装配工厂）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('有工作区 → JsonQuickCommandsStore（指向 .vscode/quick-commands.json）', async () => {
    tmpRoot = await makeTmpWorkspace()
    setWorkspace(tmpRoot)
    const store = createQuickCommandsStore(createExtensionContextStub() as unknown as never)
    expect(store).toBeInstanceOf(JsonQuickCommandsStore)
    await store.save(sampleData)
    expect(
      JSON.parse(await nodeFs.promises.readFile(quickCommandsFileUri(tmpRoot).fsPath, 'utf8'))
    ).toMatchObject({ schemaVersion: 1 })
  })

  it('无工作区 → MementoQuickCommandsStore（globalState 键）', async () => {
    __stubs.workspaceFolders = undefined
    const context = createExtensionContextStub()
    const store = createQuickCommandsStore(context as unknown as never)
    expect(store).toBeInstanceOf(MementoQuickCommandsStore)
    await store.save(sampleData)
    expect(context.globalState.__backing.get(QUICK_COMMANDS_MEMENTO_KEY)).toEqual(sampleData)
  })
})
