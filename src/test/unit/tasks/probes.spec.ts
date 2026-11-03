import { describe, expect, it } from 'vitest'
import { ENVIRONMENT_PROBES, findProbeByLabel } from '../../../extension/tasks/probes'

/**
 * 探针注册表（此前仅经 environmentTask spec 间接覆盖）：
 * 注册表结构不变式、label 路由、Java 版本解析（引号 / javac 前缀顺序）。
 */

describe('ENVIRONMENT_PROBES 注册表', () => {
  it('注册表恰含 5 个探针，label 与 id 不重复', () => {
    expect(ENVIRONMENT_PROBES.map((probe) => probe.id)).toEqual([
      'python',
      'node',
      'npm',
      'java',
      'git',
    ])
    const labels = ENVIRONMENT_PROBES.map((probe) => probe.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('每个探针至少一条候选命令且非空串', () => {
    for (const probe of ENVIRONMENT_PROBES) {
      expect(probe.commands.length).toBeGreaterThan(0)
      expect(probe.commands.every((command) => command.trim().length > 0)).toBe(true)
    }
  })
})

describe('findProbeByLabel（重检路由键）', () => {
  it('按 label 命中（大小写不敏感）；未知 label 返回 undefined', () => {
    expect(findProbeByLabel('Node.js')?.id).toBe('node')
    expect(findProbeByLabel('node.JS')?.id).toBe('node')
    expect(findProbeByLabel('Java')?.commands).toEqual(['java -version', 'javac -version'])
    expect(findProbeByLabel('操作系统')).toBeUndefined()
    expect(findProbeByLabel('VSCode')).toBeUndefined()
    expect(findProbeByLabel('不存在')).toBeUndefined()
  })
})

describe('Java 版本解析（parse 语义，经 probe.parse 直接驱动）', () => {
  const javaParse = findProbeByLabel('Java')?.parse
  it('stderr 引号输出取引号内版本号（java -version 形态）', () => {
    expect(javaParse?.('openjdk version "17.0.9" 2023-10-17')).toBe('17.0.9')
    expect(javaParse?.('"21"')).toBe('21')
  })

  it('javac 前缀完整剥离（交替顺序长词在前，残留不为 "c …"）', () => {
    expect(javaParse?.('javac 17.0.9')).toBe('17.0.9')
    expect(javaParse?.('javac version 11')).toBe('11')
  })

  it('java / openjdk 前缀与无前缀形态', () => {
    expect(javaParse?.('java version 1.8.0_392')).toBe('1.8.0_392')
    expect(javaParse?.('openjdk 21.0.1')).toBe('21.0.1')
    expect(javaParse?.('17.0.9')).toBe('17.0.9')
  })
})
