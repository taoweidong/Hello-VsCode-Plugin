import { describe, expect, it, vi } from 'vitest'
import type { SerialServer } from '../../../extension/features/serialConsole/models'
import { passwordKey } from '../../../extension/features/serialConsole/models'
import { removeServerEverywhere } from '../../../extension/features/serialConsole/serverRemoval'
import { makeServer } from './support/serverHelpers'

/**
 * 串口服务器删除的单一实现（17 方案阶段 1，P2-B2 收敛）：
 * 树右键与 webview 两条路径共用本函数，只差呈现层——
 * 落盘失败抛错、密码清理失败不阻断（secretError 上报）、联动断开当前连接。
 */

interface DepsOverrides {
  servers?: SerialServer[]
  failSave?: Error
  failSecret?: Error
  connectedId?: string
}

function makeDeps(overrides: DepsOverrides = {}) {
  let servers: SerialServer[] = (overrides.servers ?? []).map((server) => ({ ...server }))
  const secretDeletes: string[] = []
  const disconnect = vi.fn()
  const logger = vi.fn()
  const deps = {
    store: {
      async load(): Promise<SerialServer[]> {
        return servers.map((server) => ({ ...server }))
      },
      async save(next: SerialServer[]): Promise<void> {
        if (overrides.failSave) {
          throw overrides.failSave
        }
        servers = next.map((server) => ({ ...server }))
      },
    },
    secrets: {
      delete(key: string): Promise<void> {
        if (overrides.failSecret) {
          return Promise.reject(overrides.failSecret)
        }
        secretDeletes.push(key)
        return Promise.resolve()
      },
    },
    link: { connectedServerId: () => overrides.connectedId, disconnect },
    logger,
  }
  return { deps, readServers: () => servers, secretDeletes, disconnect, logger }
}

describe('removeServerEverywhere', () => {
  it('删除存在者：落盘剩余列表 + 清理对应 passwordKey + 记日志', async () => {
    const { deps, readServers, secretDeletes, disconnect, logger } = makeDeps({
      servers: [makeServer({ id: 'srv-1' }), makeServer({ id: 'srv-2', name: '乙' })],
    })
    const result = await removeServerEverywhere(deps, 'srv-1')
    expect(result).toMatchObject({ status: 'deleted' })
    if (result.status !== 'deleted') return
    expect(result.rest.map((server) => server.id)).toEqual(['srv-2'])
    expect(readServers().map((server) => server.id)).toEqual(['srv-2'])
    expect(secretDeletes).toEqual([passwordKey('srv-1')])
    expect(disconnect).not.toHaveBeenCalled()
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('已删除'))
  })

  it('删除当前连接的服务器：联动 disconnect', async () => {
    const { deps, disconnect } = makeDeps({
      servers: [makeServer({ id: 'srv-1' })],
      connectedId: 'srv-1',
    })
    await removeServerEverywhere(deps, 'srv-1')
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('目标不存在：missing 且不改任何状态', async () => {
    const { deps, readServers, secretDeletes, disconnect, logger } = makeDeps({
      servers: [makeServer({ id: 'srv-1' })],
    })
    expect(await removeServerEverywhere(deps, 'no-such')).toEqual({ status: 'missing' })
    expect(readServers()).toHaveLength(1)
    expect(secretDeletes).toEqual([])
    expect(disconnect).not.toHaveBeenCalled()
    expect(logger).not.toHaveBeenCalled()
  })

  it('落盘失败：错误向上抛，密码未被清理（此时删除未发生）', async () => {
    const { deps, secretDeletes, disconnect } = makeDeps({
      servers: [makeServer({ id: 'srv-1' })],
      failSave: new Error('disk full'),
    })
    await expect(removeServerEverywhere(deps, 'srv-1')).rejects.toThrow('disk full')
    expect(secretDeletes).toEqual([])
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('密码清理失败：删除不被阻断（deleted + secretError 上报 + 断开照常）', async () => {
    const { deps, readServers, secretDeletes, disconnect } = makeDeps({
      servers: [makeServer({ id: 'srv-1' })],
      connectedId: 'srv-1',
      failSecret: new Error('keychain locked'),
    })
    const result = await removeServerEverywhere(deps, 'srv-1')
    expect(result).toMatchObject({
      status: 'deleted',
      secretError: expect.stringContaining('清理保存的密码失败'),
    })
    expect(readServers()).toHaveLength(0)
    expect(secretDeletes).toEqual([])
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
