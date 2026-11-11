import * as nodeFs from 'node:fs'
import * as nodeOs from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { cleanupSerialLegacyData } from '../../extension/services/serialCleanup'
import { __resetStubs, __stubs, createExtensionContextStub } from './stubs/vscode'

/**
 * 串口功能下线（v4.0.0）遗留数据清理：
 * 数据文件 + SecretStorage 密码（新旧前缀）+ globalState 旧键；幂等、失败不阻断。
 */

let rootDir = ''

const dataFile = (): string => nodePath.join(rootDir, '.vscode', 'serial-servers.json')

function makeContext(): {
  context: vscode.ExtensionContext
  secrets: Map<string, string>
  deleted: string[]
} {
  const context = createExtensionContextStub() as unknown as {
    secrets: unknown
  } & vscode.ExtensionContext
  const secrets = new Map<string, string>()
  const deleted: string[] = []
  context.secrets = {
    get: (key: string) => Promise.resolve(secrets.get(key)),
    store: (key: string, value: string) => {
      secrets.set(key, value)
      return Promise.resolve()
    },
    delete: (key: string) => {
      deleted.push(key)
      secrets.delete(key)
      return Promise.resolve()
    },
  } as unknown as vscode.ExtensionContext['secrets']
  return { context, secrets, deleted }
}

function writeDataFile(content: unknown): void {
  nodeFs.mkdirSync(nodePath.join(rootDir, '.vscode'), { recursive: true })
  nodeFs.writeFileSync(dataFile(), JSON.stringify(content), 'utf8')
}

beforeEach(() => {
  __resetStubs()
  rootDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'serial-cleanup-'))
  __stubs.workspaceFolders = [
    { uri: vscode.Uri.file(rootDir), name: nodePath.basename(rootDir), index: 0 },
  ]
})

afterEach(() => {
  __stubs.workspaceFolders = undefined
  nodeFs.rmSync(rootDir, { recursive: true, force: true })
})

describe('cleanupSerialLegacyData', () => {
  it('信封数据文件：删除文件 + 清理新旧前缀密码 + 清空 globalState 旧键', async () => {
    writeDataFile({ schemaVersion: 1, servers: [{ id: 'srv-1' }, { id: 'srv-2' }] })
    const { context, deleted } = makeContext()
    await context.globalState.update('extStarter.serialServers', [{ id: 'srv-1' }])
    await context.globalState.update('extStarter.serialCommandHistory', [{ id: 'h1' }])

    const summary = await cleanupSerialLegacyData(context)

    expect(summary.removedDataFile).toBe(true)
    expect(summary.removedSecrets).toBe(4) // 2 ids × 新旧前缀
    expect(deleted).toEqual([
      'extStarter.serialServer.srv-1.password',
      'crudStarter.serialServer.srv-1.password',
      'extStarter.serialServer.srv-2.password',
      'crudStarter.serialServer.srv-2.password',
    ])
    expect(nodeFs.existsSync(dataFile())).toBe(false)
    expect(context.globalState.get('extStarter.serialServers')).toBeUndefined()
    expect(context.globalState.get('extStarter.serialCommandHistory')).toBeUndefined()
  })

  it('顶层数组宽容读取（手写形态）同样清理密码', async () => {
    writeDataFile([{ id: 'legacy-1' }])
    const { context, deleted } = makeContext()
    await cleanupSerialLegacyData(context)
    expect(deleted).toContain('extStarter.serialServer.legacy-1.password')
    expect(nodeFs.existsSync(dataFile())).toBe(false)
  })

  it('数据文件缺失：无密码可清、不抛错，globalState 旧键仍清空（幂等）', async () => {
    const { context, deleted } = makeContext()
    const summary = await cleanupSerialLegacyData(context)
    expect(summary).toEqual({ removedDataFile: false, removedSecrets: 0 })
    expect(deleted).toEqual([])
    expect(context.globalState.get('extStarter.serialServers')).toBeUndefined()
  })

  it('损坏数据文件：删除文件、跳过密码清理并留痕', async () => {
    nodeFs.mkdirSync(nodePath.join(rootDir, '.vscode'), { recursive: true })
    nodeFs.writeFileSync(dataFile(), '{ broken', 'utf8')
    const { context, deleted } = makeContext()
    const logs: string[] = []
    const summary = await cleanupSerialLegacyData(context, (message) => logs.push(message))
    expect(summary.removedDataFile).toBe(true)
    expect(deleted).toEqual([])
    expect(logs.join('\n')).toContain('串口功能已下线')
  })

  it('密码删除失败：不抛错，log 留痕（其余清理继续）', async () => {
    writeDataFile({ schemaVersion: 1, servers: [{ id: 'srv-1' }] })
    const { context } = makeContext()
    ;(context.secrets as unknown as { delete: () => Promise<void> }).delete = () =>
      Promise.reject(new Error('keychain locked'))
    const logs: string[] = []
    const summary = await cleanupSerialLegacyData(context, (message) => logs.push(message))
    expect(summary.removedDataFile).toBe(true) // 文件清理不受密码失败影响
    expect(logs.join('\n')).toContain('清理遗留串口密码失败')
    expect(nodeFs.existsSync(dataFile())).toBe(false)
  })

  it('信封缺 servers 数组 / 条目畸形 / 空 id：跳过密码清理但仍删除文件', async () => {
    writeDataFile({ schemaVersion: 1, other: [] })
    const { context, deleted } = makeContext()
    const summary = await cleanupSerialLegacyData(context)
    expect(summary.removedSecrets).toBe(0)
    expect(deleted).toEqual([])
    expect(nodeFs.existsSync(dataFile())).toBe(false)

    writeDataFile({ schemaVersion: 1, servers: ['junk', { id: '' }, { id: 42 }, { id: 'ok-1' }] })
    const second = makeContext()
    const summary2 = await cleanupSerialLegacyData(second.context)
    expect(summary2.removedSecrets).toBe(2) // 仅 ok-1（新旧前缀）
    expect(second.deleted).toEqual([
      'extStarter.serialServer.ok-1.password',
      'crudStarter.serialServer.ok-1.password',
    ])
  })

  it('读取失败（非 FileNotFound）：log 留痕后仍尝试删除文件与清键', async () => {
    const { context } = makeContext()
    const readSpy = vi
      .spyOn(vscode.workspace.fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }))
    try {
      const logs: string[] = []
      const summary = await cleanupSerialLegacyData(context, (message) => logs.push(message))
      expect(summary.removedSecrets).toBe(0)
      expect(logs.join(String.fromCharCode(10))).toContain('读取遗留串口数据失败')
    } finally {
      readSpy.mockRestore()
    }
    expect(context.globalState.get('extStarter.serialServers')).toBeUndefined()
  })

  it('删除数据文件失败：log 留痕、不抛错；globalState 清理失败同样留痕', async () => {
    writeDataFile({ schemaVersion: 1, servers: [{ id: 'srv-1' }] })
    const { context } = makeContext()
    const deleteSpy = vi
      .spyOn(vscode.workspace.fs, 'delete')
      .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
    const originalUpdate = context.globalState.update.bind(context.globalState)
    ;(
      context.globalState as unknown as { update: (key: string, value: unknown) => Promise<void> }
    ).update = (key: string, value: unknown) => {
      if (key === 'extStarter.serialCommandHistory' && value === undefined) {
        return Promise.reject(new Error('state locked'))
      }
      return Promise.resolve(originalUpdate(key, value))
    }
    const logs: string[] = []
    try {
      const summary = await cleanupSerialLegacyData(context, (message) => logs.push(message))
      expect(summary.removedDataFile).toBe(false)
      expect(logs.join(String.fromCharCode(10))).toContain('删除遗留串口数据文件失败')
      expect(logs.join(String.fromCharCode(10))).toContain('清理遗留串口全局存储失败')
    } finally {
      deleteSpy.mockRestore()
    }
  })
})
