import { beforeEach, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'
import { __resetStubs } from './stubs/vscode'
import { TaskSignalSource } from '../../extension/tasks/taskRunner'
import {
  createEnvironmentTask,
  recheckProbeByLabel,
  type ProbeExecutor,
} from '../../extension/tasks/environmentTask'
import { ENVIRONMENT_PROBES } from '../../extension/tasks/probes'
import { TaskRunner } from '../../extension/tasks/taskRunner'
import type { TaskContext } from '../../extension/tasks/types'

/** 构造任务上下文（默认不取消）。 */
function makeContext(signal = new TaskSignalSource()): TaskContext {
  return {
    output: vscode.window.createOutputChannel('CRUD Starter Test'),
    signal: signal.signal,
  }
}

/** E6 / T5.4：环境探测语义修正——err 非空一律失败 + 候选命令回退链 + 可注入执行器。 */
describe('environmentTask 探测语义（可注入执行器）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('err 非空时视为失败：即使 stdout 有内容也不当作版本号', async () => {
    const executor: ProbeExecutor = async (command) => {
      if (command === 'node --version') {
        // 失败命令打印了帮助文本（stdout 有内容）但退出码非 0
        return { err: new Error('exit 1'), stdout: 'v99.9.9\n', stderr: '' }
      }
      return { err: null, stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    const node = result.items.find((item) => item.label === 'Node.js')
    expect(node?.status).toBe('missing')
    expect(node?.description).toBe('未检测到')
  })

  it('候选命令回退链：首个候选失败时依序尝试后续候选', async () => {
    const attempted: string[] = []
    const executor: ProbeExecutor = async (command) => {
      attempted.push(command)
      if (command === 'python --version') {
        return { err: null, stdout: 'Python 3.11.4\n', stderr: '' }
      }
      if (command === 'py -3 --version') {
        return { err: new Error('exit 9009'), stdout: '', stderr: 'not found' }
      }
      return { err: null, stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    const python = result.items.find((item) => item.label === 'Python')
    expect(python?.status).toBe('ok')
    expect(python?.description).toBe('3.11.4')
    expect(python?.tooltip).toContain('python --version') // 命中候选的命令被记录
    expect(attempted).toContain('py -3 --version')
    expect(attempted).toContain('python --version')
    expect(attempted).not.toContain('python3 --version') // 命中后不再继续
  })

  it('退出码为 0 时接受 stderr 输出（兼容旧版 Python --version 走 stderr）', async () => {
    const executor: ProbeExecutor = async (command) => {
      if (command === 'node --version') {
        return { err: null, stdout: '', stderr: 'v20.11.0\n' }
      }
      return { err: null, stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    const node = result.items.find((item) => item.label === 'Node.js')
    expect(node?.status).toBe('ok')
    expect(node?.description).toBe('v20.11.0')
  })

  it('全部缺失时状态 warn；有结果时输出汇总行', async () => {
    const executor: ProbeExecutor = async () => ({ err: new Error('nope'), stdout: '', stderr: '' })
    const result = await createEnvironmentTask(executor).run(makeContext())
    expect(result.status).toBe('warn')
    expect(result.items.some((item) => item.label === '操作系统' && item.status === 'ok')).toBe(
      true
    )
  })

  it('取消信号：已请求取消时探测提前中止，summary 说明为部分结果', async () => {
    const signal = new TaskSignalSource()
    signal.cancel()
    const attempted: string[] = []
    const executor: ProbeExecutor = async (command) => {
      attempted.push(command)
      return { err: null, stdout: `out-${command}\n`, stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext(signal))
    expect(attempted).toEqual([]) // 首个候选前即中止
    expect(result.items.find((item) => item.label === 'Python')?.status).toBe('missing')
    expect(result.summary).toContain('已取消')
  })

  it('探针并行执行：多个探测命令同时在场，条目顺序保持注册表序（P2-B5）', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const executor: ProbeExecutor = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { err: null, stdout: 'v1.0\n', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    // 串行实现下任何时刻至多 1 条命令在场；并行实现下探针数 > 1
    expect(maxInFlight).toBeGreaterThan(1)
    // 并行不改变结果顺序：探针条目仍按注册表顺序排列
    const probeLabels = result.items.slice(0, ENVIRONMENT_PROBES.length).map((item) => item.label)
    expect(probeLabels).toEqual(ENVIRONMENT_PROBES.map((probe) => probe.label))
    expect(result.items.every((item) => item.status === 'ok')).toBe(true)
  })

  it('run(ctx) 签名：真实执行器下能探测到 Node.js（测试环境运行前提）', async () => {
    const result = await createEnvironmentTask().run(makeContext())
    const node = result.items.find((item) => item.label === 'Node.js')
    expect(node?.status).toBe('ok')
    expect(node?.description).toMatch(/^v/)
  }, 15000)
})

/* ================= 09 方案阶段 3：探针注册表驱动 ================= */

describe('environmentTask 探针注册表（阶段 3）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('条目 = 注册表逐项 + 操作系统 + VSCode（7 项，顺序稳定）', async () => {
    const executor: ProbeExecutor = async () => ({ err: null, stdout: '', stderr: '' })
    const result = await createEnvironmentTask(executor).run(makeContext())
    const expected = [...ENVIRONMENT_PROBES.map((probe) => probe.label), '操作系统', 'VSCode']
    expect(ENVIRONMENT_PROBES.map((probe) => probe.id)).toContain('java') // 注册表含 Java
    expect(result.items.map((item) => item.label)).toEqual(expected)
    expect(result.items).toHaveLength(7)
  })

  it('Java 探针：stdout 空但 stderr 有值（退出码 0）→ 提取引号内版本号', async () => {
    const executor: ProbeExecutor = async (command) => {
      if (command === 'java -version') {
        return {
          err: null,
          stdout: '',
          stderr: 'openjdk version "17.0.9" 2023-10-17\n',
        }
      }
      return { err: null, stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    const java = result.items.find((item) => item.label === 'Java')
    expect(java?.status).toBe('ok')
    expect(java?.description).toBe('17.0.9')
  })

  it('Java 探针：java 失败时回退 javac -version（stdout 输出）', async () => {
    const executor: ProbeExecutor = async (command) => {
      if (command === 'javac -version') {
        return { err: null, stdout: 'javac 17.0.9\n', stderr: '' }
      }
      if (command === 'java -version') {
        return { err: new Error('exit 1'), stdout: '', stderr: '' }
      }
      return { err: null, stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    const java = result.items.find((item) => item.label === 'Java')
    expect(java?.status).toBe('ok')
    expect(java?.description).toBe('17.0.9')
  })

  it('单探针失败不阻塞其他探针（Python 缺失而 Node 正常）', async () => {
    const executor: ProbeExecutor = async (command) => {
      if (command === 'node --version') {
        return { err: null, stdout: 'v20.11.0\n', stderr: '' }
      }
      return { err: new Error('not found'), stdout: '', stderr: '' }
    }
    const result = await createEnvironmentTask(executor).run(makeContext())
    expect(result.items.find((item) => item.label === 'Python')?.status).toBe('missing')
    expect(result.items.find((item) => item.label === 'Node.js')?.status).toBe('ok')
    expect(result.status).toBe('warn')
  })
})

describe('recheckProbeByLabel（单探针重检，阶段 3）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('按 label 路由：只执行目标探针的候选命令', async () => {
    const attempted: string[] = []
    const executor: ProbeExecutor = async (command) => {
      attempted.push(command)
      return command === 'git --version'
        ? { err: null, stdout: 'git version 2.43.0\n', stderr: '' }
        : { err: null, stdout: '', stderr: '' }
    }
    const item = await recheckProbeByLabel('Git', executor)
    expect(attempted).toEqual(['git --version'])
    expect(item).toMatchObject({ label: 'Git', status: 'ok' })
    expect(item?.description).toBe('2.43.0')
  })

  it('非探针条目（操作系统 / VSCode / 未知）返回 undefined，不执行任何命令', async () => {
    const executor: ProbeExecutor = async () => {
      throw new Error('不应执行')
    }
    expect(await recheckProbeByLabel('操作系统', executor)).toBeUndefined()
    expect(await recheckProbeByLabel('VSCode', executor)).toBeUndefined()
    expect(await recheckProbeByLabel('不存在', executor)).toBeUndefined()
  })
})

describe('TaskRunner.updateItem（单探针就地刷新，阶段 3）', () => {
  beforeEach(() => {
    __resetStubs()
  })

  it('替换同 label 条目并重算状态；结果经事件广播', async () => {
    const runner = new TaskRunner(
      [createEnvironmentTask(async () => ({ err: new Error('x'), stdout: '', stderr: '' }))],
      vscode.window.createOutputChannel('CRUD Starter Test')
    )
    await runner.runAll()
    expect(runner.lastResults[0].status).toBe('warn')

    let events = 0
    runner.onDidChangeItems(() => events++)
    const updated = runner.updateItem('environment', {
      label: 'Python',
      description: '3.11.4',
      status: 'ok',
    })
    expect(updated).toBe(true)
    expect(events).toBe(1)
    const result = runner.lastResults[0]
    expect(result.items.find((item) => item.label === 'Python')?.status).toBe('ok')
    // 其余缺失项仍在 → 状态仍为 warn；全部补齐后才转 ok
    expect(result.status).toBe('warn')
  })

  it('taskId 或 label 不匹配时忽略并返回 false', async () => {
    const runner = new TaskRunner(
      [createEnvironmentTask(async () => ({ err: null, stdout: 'v1\n', stderr: '' }))],
      vscode.window.createOutputChannel('CRUD Starter Test')
    )
    await runner.runAll()
    expect(runner.updateItem('other-task', { label: 'Python', status: 'ok' })).toBe(false)
    expect(runner.updateItem('environment', { label: '不存在的条目', status: 'ok' })).toBe(false)
  })
})
