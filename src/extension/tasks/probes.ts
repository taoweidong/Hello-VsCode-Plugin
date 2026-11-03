/**
 * 可插拔环境探针注册表（09 方案 §6.1 / 需求 1）。
 *
 * 新增一种语言 / 工具的检测 = 往 ENVIRONMENT_PROBES 加一项，零改动其他文件：
 * - environmentTask 遍历本表生成条目；
 * - 树视图按条目 label 找到探针、绑定单击重检；
 * - 单个探针失败不阻塞其他探针（missing 状态隔离）。
 */
export interface EnvironmentProbe {
  /** 探针 id（稳定标识；重检路由键是 label，id 仅作注册表标识） */
  id: string
  /** 展示名（同时是树视图条目 label 与重检路由键） */
  label: string
  /** 候选命令（按序回退，第一个有输出的胜出） */
  commands: readonly string[]
  /** 从输出首行提取版本号；缺省原样展示 */
  parse?: (raw: string) => string
  /** 缺失时的提示文案 */
  missingHint?: string
}

/** 从 `openjdk version "17.0.9" 2023-10-17` / `javac 17.0.9` 一类输出中取版本号。 */
function parseJavaVersion(raw: string): string {
  const quoted = /"([^"]+)"/.exec(raw)
  if (quoted?.[1]) {
    return quoted[1]
  }
  // 交替顺序长词在前：`javac` 必须先于 `java`，否则前缀匹配后残留 "c …"
  return raw.replace(/^(?:openjdk|javac|java)\s*(?:version)?\s*/i, '').trim()
}

/**
 * 探针注册表（Python / Node.js / npm / Java / Git）。
 * Java 注意：`java -version` 输出到 stderr 且部分 JDK 退出码为 0，
 * 执行器语义（退出码 0 时接受 stderr）已兼容，此处只需提取引号内版本号。
 */
export const ENVIRONMENT_PROBES: readonly EnvironmentProbe[] = [
  {
    id: 'python',
    label: 'Python',
    commands: ['py -3 --version', 'python --version', 'python3 --version'],
    parse: (raw) => raw.replace(/^Python\s*/i, ''),
    missingHint: '未检测到：安装 Python 3 或将其加入 PATH',
  },
  { id: 'node', label: 'Node.js', commands: ['node --version'] },
  { id: 'npm', label: 'npm', commands: ['npm --version'] },
  {
    id: 'java',
    label: 'Java',
    // java -version 输出到 stderr，javac -version 输出到 stdout，双通道兜底
    commands: ['java -version', 'javac -version'],
    parse: parseJavaVersion,
    missingHint: '未检测到：安装 JDK 或将 java/javac 加入 PATH',
  },
  {
    id: 'git',
    label: 'Git',
    commands: ['git --version'],
    parse: (raw) => raw.replace(/^git\s*(?:version)?\s*/i, ''),
  },
]

/** 按条目 label 查探针（树节点单击重检的路由键）；不存在返回 undefined。 */
export function findProbeByLabel(label: string): EnvironmentProbe | undefined {
  return ENVIRONMENT_PROBES.find((probe) => probe.label.toLowerCase() === label.toLowerCase())
}
