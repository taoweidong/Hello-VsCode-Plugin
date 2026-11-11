import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  createQuickCommandsStore,
  GlobalJsonQuickCommandsStore,
  JsonQuickCommandsStore,
  QuickCommandsService,
  migrateQuickCommandsMementoToFile,
  QUICK_COMMANDS_FILE_NAME,
  QUICK_COMMANDS_MEMENTO_KEY,
  QUICK_COMMANDS_SCHEMA_VERSION,
  type QuickCommandsData,
} from '../../../extension/features/quickCommands/quickCommandsService'
import { STORAGE } from '../../../extension/constants'
import { __resetStubs, __stubs, createExtensionContextStub } from '../stubs/vscode'

/**
 * 快捷命令双存储（v3.5，16 方案；v3.7.0 无工作区回退明文 JSON 化，17 方案阶段 4）：
 * 工作区 `.vscode/quick-commands.json`（信封 + 原子写 + 损坏备份）与无工作区
 * globalStorage 明文 JSON 回退；装配工厂按工作区有无二选一；激活期一次性迁移。
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
  return vscode.Uri.joinPath(vscode.Uri.file(root), ...QUICK_COMMANDS_FILE_NAME.split('/'))
}

function globalFileUri(root: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.Uri.file(root), STORAGE.quickCommandsGlobalFileName)
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

describe('QuickCommandsService.ensureDataFile（打开数据文件入口）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  afterEach(async () => {
    if (tmpRoot) {
      await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
  })

  it('文件缺失 → 写空信封（所见即存储格式）；已存在 → 不改写', async () => {
    tmpRoot = await makeTmpWorkspace()
    setWorkspace(tmpRoot)
    const store = new JsonQuickCommandsStore(quickCommandsFileUri(tmpRoot))
    const service = new QuickCommandsService(store)

    await service.ensureDataFile()
    const envelope = JSON.parse(
      await nodeFs.promises.readFile(quickCommandsFileUri(tmpRoot).fsPath, 'utf8')
    ) as Record<string, unknown>
    expect(envelope).toEqual({
      schemaVersion: QUICK_COMMANDS_SCHEMA_VERSION,
      groups: [],
      commands: [],
    })

    await nodeFs.promises.writeFile(quickCommandsFileUri(tmpRoot).fsPath, 'KEEP', 'utf8')
    await service.ensureDataFile()
    expect(await nodeFs.promises.readFile(quickCommandsFileUri(tmpRoot).fsPath, 'utf8')).toBe(
      'KEEP'
    )
    expect(service.dataFileUri().fsPath).toBe(quickCommandsFileUri(tmpRoot).fsPath)
  })
})

describe('GlobalJsonQuickCommandsStore（无工作区回退，17 方案阶段 4）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  afterEach(async () => {
    if (tmpRoot) {
      await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
  })

  it('save → load 往返；dataFileUri 透传传入文件；缺失目录自动创建', async () => {
    tmpRoot = await makeTmpWorkspace()
    const createDirectorySpy = vi.spyOn(vscode.workspace.fs, 'createDirectory')
    try {
      const store = new GlobalJsonQuickCommandsStore(globalFileUri(tmpRoot))
      await store.save(sampleData)
      expect(createDirectorySpy).toHaveBeenCalledTimes(1)
      expect(await store.load()).toEqual(sampleData)
      expect(store.dataFileUri().fsPath).toBe(globalFileUri(tmpRoot).fsPath)
    } finally {
      createDirectorySpy.mockRestore()
    }
  })

  it('损坏数据按守卫归一（缺省空数据）', async () => {
    tmpRoot = await makeTmpWorkspace()
    await nodeFs.promises.writeFile(globalFileUri(tmpRoot).fsPath, '{ broken', 'utf8')
    const warnings: string[] = []
    const store = new GlobalJsonQuickCommandsStore(globalFileUri(tmpRoot), {
      onWarning: (message) => warnings.push(message),
    })
    expect(await store.load()).toEqual<QuickCommandsData>({ groups: [], commands: [] })
    expect(warnings.join('\n')).toContain('损坏')
  })
})

describe('migrateQuickCommandsMementoToFile（激活期一次性迁移，17 方案阶段 4）', () => {
  beforeEach(() => {
    __resetStubs()
    tmpRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'quick-commands-migrate-'))
  })

  afterEach(async () => {
    __stubs.workspaceFolders = undefined
    await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
    tmpRoot = ''
  })

  function makeContext(initial: Record<string, unknown> = {}) {
    const memento = createExtensionContextStub().globalState
    const context = {
      globalState: memento,
      globalStorageUri: vscode.Uri.file(nodePath.join(tmpRoot, 'global-storage')),
    } as unknown as vscode.ExtensionContext
    if (Object.keys(initial).length > 0) {
      for (const [key, value] of Object.entries(initial)) {
        void context.globalState.update(key, value)
      }
    }
    return { memento, context }
  }

  it('无旧数据 → 静默跳过（不写文件）', async () => {
    const { memento, context } = makeContext()
    await expect(migrateQuickCommandsMementoToFile(context)).resolves.toBe(false)
    expect(memento.get(QUICK_COMMANDS_MEMENTO_KEY)).toBeUndefined()
  })

  it('全局文件已存在 → 旧键作废清除，不覆盖文件', async () => {
    const { memento, context } = makeContext({ [QUICK_COMMANDS_MEMENTO_KEY]: sampleData })
    nodeFs.mkdirSync(nodePath.join(tmpRoot, 'global-storage'), { recursive: true })
    // 全局文件已存在（globalStorage 目录内）
    await nodeFs.promises.writeFile(
      nodePath.join(tmpRoot, 'global-storage', STORAGE.quickCommandsGlobalFileName),
      'KEEP',
      'utf8'
    )
    await expect(migrateQuickCommandsMementoToFile(context)).resolves.toBe(false)
    expect(memento.get(QUICK_COMMANDS_MEMENTO_KEY)).toBeUndefined()
    expect(
      await nodeFs.promises.readFile(
        nodePath.join(tmpRoot, 'global-storage', STORAGE.quickCommandsGlobalFileName),
        'utf8'
      )
    ).toBe('KEEP')
  })

  it('文件不存在 → 归一化写入信封 + 清旧键 + onMigrated 回调一次', async () => {
    const { memento, context } = makeContext({ [QUICK_COMMANDS_MEMENTO_KEY]: sampleData })
    const migrated: vscode.Uri[] = []
    await expect(
      migrateQuickCommandsMementoToFile(context, { onMigrated: (uri) => migrated.push(uri) })
    ).resolves.toBe(true)
    expect(memento.get(QUICK_COMMANDS_MEMENTO_KEY)).toBeUndefined()
    expect(migrated).toHaveLength(1)
    const envelope = JSON.parse(
      await nodeFs.promises.readFile(
        nodePath.join(tmpRoot, 'global-storage', STORAGE.quickCommandsGlobalFileName),
        'utf8'
      )
    ) as Record<string, unknown>
    expect(envelope.schemaVersion).toBe(QUICK_COMMANDS_SCHEMA_VERSION)
    expect(envelope.groups).toEqual(sampleData.groups)
    expect(envelope.commands).toEqual(sampleData.commands)
  })

  it('写失败 → 错误上抛，旧键保留', async () => {
    const { memento, context } = makeContext({ [QUICK_COMMANDS_MEMENTO_KEY]: sampleData })
    const writeFileSpy = vi
      .spyOn(vscode.workspace.fs, 'writeFile')
      .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'EACCES' }))
    try {
      await expect(migrateQuickCommandsMementoToFile(context)).rejects.toThrow()
    } finally {
      writeFileSpy.mockRestore()
    }
    expect(memento.get(QUICK_COMMANDS_MEMENTO_KEY)).toEqual(sampleData)
  })
})

describe('createQuickCommandsStore（装配工厂）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  afterEach(async () => {
    __stubs.workspaceFolders = undefined
    if (tmpRoot) {
      await nodeFs.promises.rm(tmpRoot, { recursive: true, force: true })
      tmpRoot = ''
    }
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

  it('无工作区 → GlobalJsonQuickCommandsStore（globalStorage 明文 JSON，17 方案阶段 4）', async () => {
    tmpRoot = await makeTmpWorkspace()
    __stubs.workspaceFolders = undefined
    const context = createExtensionContextStub() as unknown as {
      globalStorageUri: vscode.Uri
    } & vscode.ExtensionContext
    context.globalStorageUri = vscode.Uri.file(nodePath.join(tmpRoot, 'global-storage'))
    const store = createQuickCommandsStore(context as unknown as never)
    expect(store).toBeInstanceOf(GlobalJsonQuickCommandsStore)
    await store.save(sampleData)
    const onDisk = JSON.parse(
      await nodeFs.promises.readFile(
        nodePath.join(tmpRoot, 'global-storage', STORAGE.quickCommandsGlobalFileName),
        'utf8'
      )
    ) as Record<string, unknown>
    expect(onDisk.schemaVersion).toBe(QUICK_COMMANDS_SCHEMA_VERSION)
  })
})
