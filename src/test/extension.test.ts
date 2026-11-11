import * as assert from 'assert'
import * as nodeOs from 'node:os'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import * as vscode from 'vscode'
import { setTimeout as delay } from 'node:timers/promises'

/** 轮询等待面板标签页出现（面板创建是异步装配，命令返回时不一定已入 tabGroups）。 */
async function vi_tabWait(hasPanel: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (hasPanel()) {
      return
    }
    await delay(200)
  }
}
import { environmentTask } from '../extension/tasks/environmentTask'
import { TaskRunner } from '../extension/tasks/taskRunner'
import type { StartupTask, TaskResult } from '../extension/tasks/types'
import { InitService } from '../extension/features/init/initService'
import type { InitStep } from '../extension/features/init/initSteps'
import {
  loadWorkspaceTasks,
  taskKey,
  type WorkspaceTaskEntry,
} from '../extension/features/taskExplorer/taskSource'
import { TaskExplorerTreeProvider } from '../extension/features/taskExplorer/taskExplorerTreeProvider'
import { TaskStatusTracker } from '../extension/features/taskExplorer/taskStatusTracker'
import { TaskUsageStore } from '../extension/features/taskExplorer/taskUsageStore'
import type { TaskExplorerNode } from '../extension/features/taskExplorer/taskExplorerTreeProvider'

/**
 * 宿主集成测试（@vscode/test-electron，09 方案阶段 2 后）：
 * 条目 / 特性配置 / 静态配置 / 存储层四组已随领域删除，
 * 保留启动任务框架 / 环境初始化 / 任务管理（CRUD） / Task Explorer（v2.3 冒烟 + 全流程）
 * 与「全流程真实环境验证」（其余领域的深度覆盖在单测）。
 */

/** 轮询等待（支持异步谓词），超时抛出带说明的错误。 */
async function vi_waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10000
): Promise<void> {
  const startedAt = Date.now()
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：${what}`)
    }
    await delay(100)
  }
}

/** 找树节点：在 provider 的分组 children 里按 label 检索 task 节点。 */
async function findTaskNode(
  provider: TaskExplorerTreeProvider,
  label: string,
  group: 'recent' | 'favorites' | 'tasks'
): Promise<{ kind: 'task'; entry: WorkspaceTaskEntry } | undefined> {
  const groups = (await provider.getChildren()) as Extract<TaskExplorerNode, { kind: 'group' }>[]
  const target = groups.find((node) => node.group === group)
  if (!target) {
    return undefined
  }
  // 工作区任务组的任务嵌在 file（单根 / 多根 folder -> file）与虚拟 taskFolder
  // （v2.4：label 按 '-' 分段）节点之下，逐层下钻
  const drill = async (nodes: TaskExplorerNode[]): Promise<TaskExplorerNode | undefined> => {
    for (const node of nodes) {
      if (node.kind === 'task' && node.entry.label === label) {
        return node
      }
      if (node.kind === 'file' || node.kind === 'folder' || node.kind === 'taskFolder') {
        const found = await drill(await provider.getChildren(node))
        if (found) {
          return found
        }
      }
    }
    return undefined
  }
  return (await drill(await provider.getChildren(target))) as
    { kind: 'task'; entry: WorkspaceTaskEntry } | undefined
}

/** 宿主侧 provider 装配（真实 vscode API + 内存 Memento）。 */
function makeHostTaskProvider() {
  const output = vscode.window.createOutputChannel('TaskExplorer E2E')
  const backing = new Map<string, unknown>()
  const memento = {
    get: (key: string, defaultValue?: unknown) =>
      backing.has(key) ? backing.get(key) : defaultValue,
    update: async (key: string, value: unknown): Promise<void> => void backing.set(key, value),
    keys: () => [...backing.keys()],
    setKeysForSync: () => undefined,
  } as unknown as vscode.Memento
  const usage = new TaskUsageStore(memento, output)
  const status = new TaskStatusTracker(output)
  const provider = new TaskExplorerTreeProvider(usage, status, output)
  return {
    provider,
    usage,
    status,
    dispose(): void {
      provider.dispose()
      status.dispose()
      usage.dispose()
    },
  }
}

suite('启动任务框架', () => {
  function fakeTask(id: string, title: string, behavior: () => Promise<void>): StartupTask {
    return {
      id,
      title,
      async run() {
        await behavior()
        return {
          taskId: id,
          taskTitle: title,
          status: 'ok',
          durationMs: 1,
          finishedAt: new Date().toISOString(),
          items: [{ label: '示例', description: '1.0.0', status: 'ok' }],
        }
      },
    }
  }

  test('TaskRunner 依次执行任务并发出变更事件（逐任务事件，任务数 + 2）', async () => {
    let runs = 0
    const task = fakeTask('demo', '演示任务', async () => {
      runs++
    })
    const runner = new TaskRunner([task], vscode.window.createOutputChannel('CRUD Starter Test'))
    let events = 0
    runner.onDidChangeItems(() => events++)
    await runner.runAll()
    assert.strictEqual(runs, 1)
    // T5.4 事件节奏：开始一次 + 每个任务完成后一次 + 结束一次（1 个任务 → 3 次）
    assert.strictEqual(events, 3)
    assert.strictEqual(runner.lastResults.length, 1)
    assert.strictEqual(runner.lastResults[0].items[0].label, '示例')
  })

  test('任务抛错时降级为 error 结果且不影响后续任务', async () => {
    const boom = fakeTask('boom', '爆炸任务', async () => {
      throw new Error('boom')
    })
    const okTask = fakeTask('ok', '正常任务', async () => undefined)
    const runner = new TaskRunner(
      [boom, okTask],
      vscode.window.createOutputChannel('CRUD Starter Test')
    )
    await runner.runAll()
    assert.strictEqual(runner.lastResults.length, 2)
    assert.strictEqual(runner.lastResults[0].status, 'error')
    assert.strictEqual(runner.lastResults[1].status, 'ok')
  })

  test('环境检测产出语义化结果（Node.js 必检到；Python/Git 状态合法即可）', async () => {
    const runner = new TaskRunner(
      [environmentTask],
      vscode.window.createOutputChannel('CRUD Starter Test')
    )
    await runner.runAll()
    const env = runner.lastResults[0]
    // Node.js 是 npm test 自身的运行前提：必须 ok 且版本号以 v 开头
    const node = env.items.find((item) => item.label === 'Node.js')
    assert.ok(node, '应包含 Node.js 条目')
    assert.strictEqual(node.status, 'ok')
    assert.match(node.description ?? '', /^v/)
    // Python / Git 依赖开发机真实安装：条目必须存在，状态只要求语义合法（P1-13 修复：
    // 不再断言「标签存在即通过」的恒真条件，无 Python 的机器上为 missing）
    for (const label of ['Python', 'Git']) {
      const entry = env.items.find((item) => item.label === label)
      assert.ok(entry, `应包含 ${label} 条目`)
      assert.ok(
        entry.status === 'ok' || entry.status === 'missing',
        `${label} 状态应为 ok/missing（实际：${entry.status}）`
      )
    }
  })

  test('任务超时被裁决为 error「任务超时」（T5.4 / P1-11）', async () => {
    const hang: StartupTask = {
      id: 'hang',
      title: '挂死任务',
      timeoutMs: 100,
      run: () => new Promise<TaskResult>(() => undefined), // 永不完成
    }
    const runner = new TaskRunner([hang], vscode.window.createOutputChannel('CRUD Starter Test'))
    await runner.runAll()
    assert.strictEqual(runner.lastResults.length, 1)
    assert.strictEqual(runner.lastResults[0].status, 'error')
    assert.match(runner.lastResults[0].summary ?? '', /任务超时/)
    assert.strictEqual(runner.isRunning, false)
  })
})

suite('环境初始化', () => {
  test('步骤顺序执行：失败不阻断后续步骤', async () => {
    const steps: InitStep[] = [
      { id: 'a', title: 'A', description: '', run: async () => 'ok-a' },
      {
        id: 'b',
        title: 'B',
        description: '',
        run: async () => {
          throw new Error('bad')
        },
      },
      { id: 'c', title: 'C', description: '', run: async () => 'ok-c' },
    ]
    const output = vscode.window.createOutputChannel('CRUD Starter Test')
    const svc = new InitService(steps, output)
    await svc.runAll()
    const states = svc.getStates()
    assert.strictEqual(states[0].status, 'done')
    assert.strictEqual(states[0].message, 'ok-a')
    assert.strictEqual(states[1].status, 'failed')
    assert.strictEqual(states[1].message, 'bad')
    assert.strictEqual(states[2].status, 'done')
  })

  test('runStep 在 runAll 执行期间被忽略（T5.4 / P1-12 单步互斥）', async () => {
    let releaseFirst!: () => void
    const steps: InitStep[] = [
      {
        id: 'a',
        title: 'A',
        description: '',
        run: () =>
          new Promise<string>((resolve) => {
            releaseFirst = () => resolve('ok-a')
          }),
      },
      { id: 'b', title: 'B', description: '', run: async () => 'ok-b' },
    ]
    const output = vscode.window.createOutputChannel('CRUD Starter Test')
    const svc = new InitService(steps, output)
    const running = svc.runAll()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.strictEqual(svc.isRunning, true)
    await svc.runStep('b') // runAll 进行中：被忽略
    assert.strictEqual(svc.getStates().find((state) => state.id === 'b')?.status, 'idle')
    releaseFirst()
    await running
    assert.strictEqual(svc.getStates().find((state) => state.id === 'b')?.status, 'done')
  })
})

suite('任务管理（v2.6 端到端冒烟）', () => {
  test('openTaskManager 打开弹框：真实宿主出现面板标签页；refreshTaskManager 可执行', async () => {
    await vscode.commands.executeCommand('extStarter.openTaskManager')
    // 经公开 API 断言（测试进程与扩展 bundle 是两个模块实例，不能查内部注册表）：
    // 面板创建成功 ⇔ 出现 viewType 匹配的编辑器标签页
    const hasPanel = (): boolean =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => {
          // 测试宿主的 Tab 不暴露 viewType（proposed API，dump 实证为 undefined）：
          // 兼容 label 匹配（webview 面板标签 = 页面标题「任务管理」）
          const viewType = String((tab as unknown as { viewType?: string }).viewType ?? '')
          return viewType.endsWith('.taskManager') || (tab.label ?? '').includes('任务管理')
        })
    await vi_tabWait(hasPanel)
    assert.ok(hasPanel(), '任务管理弹框面板应已创建（tabGroups 可见）')

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.refreshTaskManager')
    }, '刷新命令应可执行（树视图 + provider 接线成功）')
  })
})

suite('串口控制台（命令装配冒烟）', () => {
  test('openSerialConsole 打开面板；打开态下 addSerialServer / refreshSerialServers 可执行', async () => {
    // 此前 serialConsole 六条命令的装配接线无任何一层测试（第五轮评估盲区 1）：
    // 这里走真实宿主验证「命令 → 控制器 → 面板」链路
    await vscode.commands.executeCommand('extStarter.openSerialConsole')
    const hasPanel = (): boolean =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => {
          const viewType = String((tab as unknown as { viewType?: string }).viewType ?? '')
          return viewType.endsWith('.serialConsole') || (tab.label ?? '').includes('串口控制台')
        })
    await vi_tabWait(hasPanel)
    assert.ok(hasPanel(), '串口控制台面板应已创建（tabGroups 可见）')

    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.addSerialServer')
      await vscode.commands.executeCommand('extStarter.refreshSerialServers')
    }, '新增 / 刷新命令应可执行（命令 → 控制器接线成功）')
  })
})

suite('Task Explorer（v2.3 集成冒烟）', () => {
  test('8 条任务管理器命令全部注册', async () => {
    const commands = new Set(await vscode.commands.getCommands())
    for (const id of [
      'extStarter.refreshTaskExplorer',
      'extStarter.runWorkspaceTask',
      'extStarter.stopWorkspaceTask',
      'extStarter.openTasksJson',
      'extStarter.locateTaskInTasksJson',
      'extStarter.addTaskToFavorites',
      'extStarter.removeTaskFromFavorites',
      'extStarter.clearRecentTasks',
    ]) {
      assert.ok(commands.has(id), `命令未注册：${id}`)
    }
  })

  test('仓库自带 npm 任务可被 fetchTasks 发现且 source/scope 满足过滤条件（M0/R1 实证）', async () => {
    // 关键假设的宿主实证：tasks.json 任务 source === 'Workspace' 且 scope 为 WorkspaceFolder
    // （用户级 / .code-workspace 任务无文件夹 scope，是数据层过滤的依据）
    const tasks = await vscode.tasks.fetchTasks()
    const npmTasks = tasks.filter(
      (task) => task.source === 'Workspace' && typeof task.scope === 'object'
    )
    const names = npmTasks.map((task) => task.name)
    assert.ok(
      names.some((name) => name.includes('compile')),
      `应发现仓库 npm: compile 任务（实际 Workspace 任务：${names.join(', ')}）`
    )
    assert.ok(
      names.some((name) => name.includes('watch')),
      `应发现仓库 npm: watch 任务`
    )
    // 扩展 provider 任务（source=npm）不应混入过滤结果
    assert.ok(
      npmTasks.every((task) => typeof task.scope === 'object' && 'uri' in (task.scope as object)),
      'Workspace 来源任务的 scope 应为 WorkspaceFolder'
    )
  })

  test('定位命令可执行（仓库 tasks.json 中存在 npm: compile 的 label 行）', async () => {
    const tasks = await vscode.tasks.fetchTasks()
    const compile = tasks.find(
      (task) =>
        task.source === 'Workspace' &&
        task.name.includes('compile') &&
        typeof task.scope === 'object'
    )
    assert.ok(compile, '应能取回 compile 任务')
    // 定位是只读操作：未命中也只提示，不抛错
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.locateTaskInTasksJson', compile)
    })
  })
})

suite('Task Explorer 全流程真实环境验证（多任务类型 / 树结构 / 运行停止 / 定位）', () => {
  /**
   * 真实宿主 E2E：向仓库 `.vscode/tasks.json` **临时**合并多种任务 fixtures
   * （shell / process / 分组 / dependsOn / Unicode 标签 / 注释噪声），用真实
   * fetchTasks + 真实扩展命令做端到端断言，测后恢复原文件。
   *
   * 不用 `updateWorkspaceFolders` 挂临时目录：单根 ↔ 多根切换会触发扩展宿主重启
   * 且污染测试实例的会话恢复（实测），无法支撑进程内断言；多根树形（文件夹 →
   * tasks.json → 任务）的层级逻辑由单测桩覆盖，本套件验证单根真实链路。
   * 树结构经测试进程内新建的 provider 实例读取（测试进程与扩展 bundle 是两个
   * 模块实例，无法直读扩展注册的 TreeView，但两者消费同一真实 API 与数据）。
   */

  const TASKS_JSON_PATH = nodePath.join(extensionDevelopmentRoot(), '.vscode', 'tasks.json')

  /** 仓库根（launchArgs 第一项），用于定位 .vscode/tasks.json。 */
  function extensionDevelopmentRoot(): string {
    // 编译产物位于 <root>/out/test/ → 上溯两级即仓库根
    return nodePath.resolve(__dirname, '../..')
  }

  let originalTasksJson = ''

  const e2eEntries = async (): Promise<WorkspaceTaskEntry[]> =>
    (await loadWorkspaceTasks()).filter((entry) => entry.label.startsWith('e2e-'))

  /** 诊断转储：fetchTasks 概要（发现失败时给出可行动信息）。 */
  const discoveryDump = async (): Promise<string> => {
    const all = await vscode.tasks.fetchTasks()
    const labels = all
      .filter((t) => t.source === 'Workspace')
      .map(
        (t) =>
          `${t.name} [${
            typeof t.scope === 'object'
              ? String((t.scope as { uri: { fsPath: string } }).uri.fsPath)
              : String(t.scope)
          }]`
      )
    return [
      `workspace 任务 ${all.length} 条（Workspace 来源 ${labels.length} 条）：`,
      ...labels.map((l) => `  ${l}`),
    ].join('\n')
  }

  suiteSetup(async function (this: Mocha.Context): Promise<void> {
    this.timeout(30000)
    originalTasksJson = nodeFs.readFileSync(TASKS_JSON_PATH, 'utf8')
    // 残留防护（第五轮）：宿主进程硬崩会跳过 suiteTeardown，tasks.json 里留下
    // 上轮 e2e-* fixtures——先清掉再读「原件」，避免脏数据被当原样恢复
    if (originalTasksJson.includes('"e2e-')) {
      nodeFs.writeFileSync(
        TASKS_JSON_PATH,
        JSON.stringify({
          version: 2,
          tasks: (JSON.parse(originalTasksJson) as { tasks: unknown[] }).tasks.filter(
            (entry) => !String((entry as { label?: unknown }).label ?? '').startsWith('e2e-')
          ),
        })
      )
      originalTasksJson = nodeFs.readFileSync(TASKS_JSON_PATH, 'utf8')
    }
    const original = JSON.parse(originalTasksJson) as {
      version: string
      tasks: Record<string, unknown>[]
    }
    // 合并 fixtures（保留原 npm 任务，M0 冒烟套件不受影响）；顶部注释验证 JSONC 容忍
    const merged = JSON.stringify(
      {
        version: original.version,
        tasks: [
          ...original.tasks,
          { label: 'e2e-shell-build', type: 'shell', command: 'echo build', group: 'build' },
          { label: 'e2e-shell-test', type: 'shell', command: 'echo test', group: 'test' },
          {
            label: 'e2e-process',
            type: 'process',
            command: 'node',
            args: ['-e', 'console.log(1)'],
          },
          { label: 'e2e-长名称 带空格（v2）', type: 'shell', command: 'echo unicode' },
          {
            label: 'e2e-run-stop',
            type: 'process',
            command: 'node',
            args: ['-e', 'setTimeout(function () {}, 10000)'],
          },
          {
            label: 'e2e-dep-main',
            type: 'shell',
            command: 'echo main',
            dependsOn: ['e2e-dep-first'],
          },
          { label: 'e2e-dep-first', type: 'shell', command: 'echo dep' },
          { label: 'e2e-locate', type: 'shell', command: 'echo locate' },
        ],
      },
      null,
      2
    )
    // 在 e2e-locate 的 label 行前插入注释噪声（label: "decoy"）——定位不得误命中
    const withNoise = merged.replace(
      '"label": "e2e-locate"',
      '// 注释噪声：label: "decoy"\n    "label": "e2e-locate"'
    )
    nodeFs.writeFileSync(TASKS_JSON_PATH, withNoise, 'utf8')

    if ((await e2eEntries()).length < 8) {
      try {
        await vi_waitFor(async () => (await e2eEntries()).length >= 8, 'e2e 任务被发现', 15000)
      } catch (error) {
        throw new Error(`${String(error)}\n诊断：\n${await discoveryDump()}`, {
          cause: error,
        })
      }
    }
  })

  suiteTeardown(async function (this: Mocha.Context): Promise<void> {
    this.timeout(15000)
    // 清场：终止残留的 e2e 执行 → 恢复原 tasks.json → 关编辑器
    for (const execution of [...vscode.tasks.taskExecutions]) {
      if (execution.task.name.startsWith('e2e-')) {
        try {
          execution.terminate()
        } catch {
          // 已结束的任务 terminate 可能 reject，忽略
        }
      }
    }
    if (originalTasksJson) {
      nodeFs.writeFileSync(TASKS_JSON_PATH, originalTasksJson, 'utf8')
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('多种任务类型被真实发现：shell/process/分组/dependsOn/Unicode 标签', async () => {
    const entries = await e2eEntries()
    const labels = entries.map((entry) => entry.label)
    for (const expected of [
      'e2e-shell-build',
      'e2e-shell-test',
      'e2e-process',
      'e2e-长名称 带空格（v2）',
      'e2e-run-stop',
      'e2e-dep-main',
      'e2e-dep-first',
      'e2e-locate',
    ]) {
      assert.ok(labels.includes(expected), `应发现任务 ${expected}（实际：${labels.join(', ')}）`)
    }
    // 全部为 Workspace 来源 + 文件夹 scope（用户级/扩展 provider 任务不混入）
    assert.ok(
      entries.every(
        (entry) => entry.task.source === 'Workspace' && typeof entry.task.scope === 'object'
      )
    )

    // 分组语义由引擎解析：build/test 分组任务带原生 TaskGroup
    const build = entries.find((entry) => entry.label === 'e2e-shell-build')!
    assert.strictEqual(build.task.group?.id, 'build')
    const test = entries.find((entry) => entry.label === 'e2e-shell-test')!
    assert.strictEqual(test.task.group?.id, 'test')

    // process 任务：execution 为 ProcessExecution（真实解析结果）
    const proc = entries.find((entry) => entry.label === 'e2e-process')!
    assert.ok((proc.task.execution as { process?: string }).process?.includes('node'))

    // 稳定 key 含 scopeUri（同一文件内不与仓库 npm 任务串扰）
    assert.ok(taskKey(build.task).includes(build.folder.uri.toString()))
  })

  test('树形结构（单根）：三组根 → tasks.json → 全部任务；图标按类型/分组', async function (this: Mocha.Context): Promise<void> {
    this.timeout(40000)
    const host = makeHostTaskProvider()
    try {
      const groups = (await host.provider.getChildren()) as Extract<
        TaskExplorerNode,
        { kind: 'group' }
      >[]
      assert.deepStrictEqual(
        groups.map((node) => node.group),
        ['recent', 'favorites', 'tasks'],
        '三组根节点顺序固定'
      )
      assert.ok(
        groups.every(
          (node) =>
            host.provider.getTreeItem(node).collapsibleState ===
            vscode.TreeItemCollapsibleState.Expanded
        ),
        '三组默认展开'
      )

      // 单根：工作区任务组直接是 tasks.json 文件节点
      const fileNodes = (await host.provider.getChildren(groups[2]!)) as Extract<
        TaskExplorerNode,
        { kind: 'file' }
      >[]
      assert.strictEqual(fileNodes.length, 1, '单根工作区只有一个 tasks.json 节点')
      const fileItem = host.provider.getTreeItem(fileNodes[0]!)
      assert.strictEqual(fileItem.label, 'tasks.json')
      assert.strictEqual(fileItem.contextValue, 'tasksFile')
      assert.strictEqual(fileItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded)
      assert.strictEqual(fileItem.command?.command, 'extStarter.openTasksJson')
      assert.ok(
        fileItem.resourceUri?.toString().endsWith('.vscode/tasks.json'),
        `resourceUri 应指向 tasks.json（实际 ${String(fileItem.resourceUri)}）`
      )

      // 文件节点下（v3.1 默认 maxLevel=5 + 叶子短名）：
      // 无横线的 npm 任务是叶子；8 条 e2e-* 全部收进虚拟文件夹 e2e，
      // 其中 e2e-shell-* 再共享前缀 → 第二层虚拟文件夹 shell
      const rootChildren = (await host.provider.getChildren(fileNodes[0]!)) as TaskExplorerNode[]
      const e2eFolder = rootChildren.find(
        (node) => node.kind === 'taskFolder' && node.name === 'e2e'
      ) as Extract<TaskExplorerNode, { kind: 'taskFolder' }> | undefined
      assert.ok(e2eFolder, 'e2e-* 任务应收进虚拟文件夹 e2e')
      assert.strictEqual(e2eFolder.count, 8)
      assert.strictEqual(e2eFolder.path, 'e2e')

      const e2eFolderItem = host.provider.getTreeItem(e2eFolder)
      assert.strictEqual(e2eFolderItem.contextValue, 'taskExplorerTaskFolder')
      assert.strictEqual(e2eFolderItem.description, '8 个任务')
      assert.strictEqual((e2eFolderItem.iconPath as vscode.ThemeIcon).id, 'folder')
      assert.strictEqual(e2eFolderItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded)

      // 默认深度 5 层：e2e 下继续按第二段拆出 dep / run / shell 三个虚拟文件夹，
      // 其余三条任务没有二级分隔符，直接是叶子
      const e2eChildren = (await host.provider.getChildren(e2eFolder)) as TaskExplorerNode[]
      const e2eFolders = e2eChildren.filter(
        (node): node is Extract<TaskExplorerNode, { kind: 'taskFolder' }> =>
          node.kind === 'taskFolder'
      )
      assert.deepStrictEqual(
        e2eFolders.map((node) => `${node.name}:${node.path}:${node.count}`).sort(),
        ['dep:e2e-dep:2', 'run:e2e-run:1', 'shell:e2e-shell:2']
      )
      const e2eDirectLeaves = e2eChildren.filter(
        (node): node is Extract<TaskExplorerNode, { kind: 'task' }> => node.kind === 'task'
      )
      assert.deepStrictEqual(
        e2eDirectLeaves.map((node) => `${node.displayLabel}:${node.entry.label}`).sort(),
        [
          'locate:e2e-locate',
          'process:e2e-process',
          '长名称 带空格（v2）:e2e-长名称 带空格（v2）',
        ].sort()
      )

      const folder = (name: string): Extract<TaskExplorerNode, { kind: 'taskFolder' }> =>
        e2eFolders.find((node) => node.name === name)!
      const taskStrings = async (name: string): Promise<string[]> => {
        const children = (await host.provider.getChildren(folder(name))) as Extract<
          TaskExplorerNode,
          { kind: 'task' }
        >[]
        return children.map((node) => `${node.displayLabel}:${node.entry.label}`).sort()
      }
      // 各层叶子显示剥前缀短名（entry.label 保持完整）
      assert.deepStrictEqual(await taskStrings('shell'), [
        'build:e2e-shell-build',
        'test:e2e-shell-test',
      ])
      assert.deepStrictEqual(await taskStrings('dep'), ['first:e2e-dep-first', 'main:e2e-dep-main'])
      assert.deepStrictEqual(await taskStrings('run'), ['stop:e2e-run-stop'])

      const shellChildren = (await host.provider.getChildren(folder('shell'))) as Extract<
        TaskExplorerNode,
        { kind: 'task' }
      >[]

      const directLeaves = rootChildren
        .filter((node) => node.kind === 'task')
        .map((node) => (node as Extract<TaskExplorerNode, { kind: 'task' }>).entry.label)
      assert.deepStrictEqual(directLeaves.sort(), ['npm: compile', 'npm: watch'])

      const buildLeaf = shellChildren.find((node) => node.entry.label === 'e2e-shell-build')!
      const buildLeafItem = host.provider.getTreeItem(buildLeaf)
      assert.strictEqual(buildLeafItem.label, 'build') // 剥前缀短名
      assert.strictEqual(
        String((buildLeafItem.tooltip as vscode.MarkdownString).value).startsWith(
          '**e2e-shell-build**'
        ),
        true,
        'tooltip 保留完整任务名'
      )

      const iconOf = (node: TaskExplorerNode): string =>
        (host.provider.getTreeItem(node).iconPath as vscode.ThemeIcon).id
      const npmLeaf = rootChildren.find(
        (node) => node.kind === 'task' && node.entry.label === 'npm: compile'
      )!
      assert.strictEqual(iconOf(npmLeaf), 'tools') // 分组 build 优先
      assert.strictEqual(iconOf(buildLeaf), 'tools')
      assert.strictEqual(
        iconOf(shellChildren.find((node) => node.entry.label === 'e2e-shell-test')!),
        'beaker'
      )
      assert.strictEqual(
        iconOf(e2eDirectLeaves.find((node) => node.entry.label === 'e2e-process')!),
        'gear' // process 类型
      )

      // 配置覆盖：taskGroupMaxLevel=1 + stripLabel=false → e2e 下平铺 8 条完整名叶子
      const extConfig = vscode.workspace.getConfiguration('extStarter')
      try {
        await extConfig.update('taskGroupMaxLevel', 1, vscode.ConfigurationTarget.Global)
        await extConfig.update('taskGroupStripTaskLabel', false, vscode.ConfigurationTarget.Global)
        // 配置写入到配置服务生效是异步的：轮询到实际值再下钻（失败带 inspect 诊断）
        const waitConfig = async (key: string, expected: unknown): Promise<void> => {
          const startedAt = Date.now()
          for (;;) {
            // 每次取全新 configuration 对象（测试宿主上捕获对象可能持有过期模型）
            if (vscode.workspace.getConfiguration('extStarter').get(key) === expected) {
              return
            }
            if (Date.now() - startedAt > 10000) {
              const actual = extConfig.get(key)
              throw new Error(
                `配置未生效：${key} 期望 ${String(expected)}，实际 ${JSON.stringify(
                  actual
                )}（${typeof actual}），inspect=${JSON.stringify(extConfig.inspect(key))}`
              )
            }
            await delay(100)
          }
        }
        await waitConfig('taskGroupMaxLevel', 1)
        await waitConfig('taskGroupStripTaskLabel', false)
        // 分组配置变化触发全树重建（与扩展内 onDidChangeConfiguration 行为一致）：
        // 重建后 group/file/taskFolder 都是新实例，必须重新取节点
        await host.provider.refresh()
        const groupsAfter = (await host.provider.getChildren()) as Extract<
          TaskExplorerNode,
          { kind: 'group' }
        >[]
        const fileNodeAfter = (
          (await host.provider.getChildren(groupsAfter[2]!)) as Extract<
            TaskExplorerNode,
            { kind: 'file' }
          >[]
        )[0]!
        const rootAfter = (await host.provider.getChildren(fileNodeAfter)) as TaskExplorerNode[]
        const e2eFolderAfter = rootAfter.find(
          (node) => node.kind === 'taskFolder' && node.name === 'e2e'
        ) as Extract<TaskExplorerNode, { kind: 'taskFolder' }> | undefined
        assert.ok(e2eFolderAfter, '重建后 e2e 文件夹仍存在')
        const flatLeaves = (await host.provider.getChildren(e2eFolderAfter)) as Extract<
          TaskExplorerNode,
          { kind: 'task' }
        >[]
        assert.strictEqual(flatLeaves.length, 8, 'maxLevel=1 时 e2e 下平铺 8 条叶子')
        assert.ok(
          flatLeaves.every((node) => node.displayLabel === undefined),
          'stripLabel=false 时不剥前缀（displayLabel 为空）'
        )
        const flatLeafItem = host.provider.getTreeItem(
          flatLeaves.find((node) => node.entry.label === 'e2e-shell-build')!
        )
        assert.strictEqual(flatLeafItem.label, 'e2e-shell-build') // stripLabel=false 完整名

        // 单击任务 = 运行命令 + 原始 Task 参数（红线）
        const buildNode = flatLeaves.find((node) => node.entry.label === 'e2e-shell-build')!
        const buildItem = host.provider.getTreeItem(buildNode)
        assert.strictEqual(buildItem.command?.command, 'extStarter.runWorkspaceTask')
        assert.ok(buildItem.command?.arguments?.[0] instanceof vscode.Task)
        assert.strictEqual(buildItem.command?.arguments?.[0], buildNode.entry.task)
        assert.strictEqual(buildItem.description, '构建')
      } finally {
        await extConfig.update('taskGroupMaxLevel', undefined, vscode.ConfigurationTarget.Global)
        await extConfig.update(
          'taskGroupStripTaskLabel',
          undefined,
          vscode.ConfigurationTarget.Global
        )
      }
    } finally {
      host.dispose()
    }
  })

  test('收藏与最近运行分组：按名称排序 / 时间倒序 / 清空不影响收藏', async () => {
    const host = makeHostTaskProvider()
    try {
      const entries = await e2eEntries()
      const build = entries.find((entry) => entry.label === 'e2e-shell-build')!
      const locate = entries.find((entry) => entry.label === 'e2e-locate')!
      const proc = entries.find((entry) => entry.label === 'e2e-process')!

      host.usage.addFavorite(locate.ref)
      host.usage.addFavorite(build.ref)
      const groups = (await host.provider.getChildren()) as Extract<
        TaskExplorerNode,
        { kind: 'group' }
      >[]
      const favorites = (await host.provider.getChildren(groups[1]!)) as Extract<
        TaskExplorerNode,
        { kind: 'task' }
      >[]
      assert.deepStrictEqual(
        favorites.map((node) => node.entry.label),
        ['e2e-locate', 'e2e-shell-build'], // 按任务名排序（localeCompare 升序）
        '收藏组按任务名排序'
      )

      // 运行记录倒序 + 分组计数（真实 store 数据驱动）。
      // 注意：usage 事件会整体重建 group 节点实例，必须重新拉取根节点再取 children
      host.usage.recordRun(proc.ref, 100)
      host.usage.recordRun(build.ref, 200)
      const groupsAfterRun = (await host.provider.getChildren()) as Extract<
        TaskExplorerNode,
        { kind: 'group' }
      >[]
      const recent = (await host.provider.getChildren(groupsAfterRun[0]!)) as Extract<
        TaskExplorerNode,
        { kind: 'task' }
      >[]
      assert.deepStrictEqual(
        recent.map((node) => node.entry.label),
        ['e2e-shell-build', 'e2e-process'],
        '最近运行最新在前'
      )
      const recentItem = host.provider.getTreeItem(groupsAfterRun[0]!)
      assert.strictEqual(recentItem.description, '2 条')

      // 清空最近运行不影响收藏
      host.usage.clearRecent()
      const groupsAfter = (await host.provider.getChildren()) as Extract<
        TaskExplorerNode,
        { kind: 'group' }
      >[]
      assert.strictEqual(
        ((await host.provider.getChildren(groupsAfter[0]!)) as TaskExplorerNode[]).length,
        1,
        '最近运行清空后只剩「暂无」占位'
      )
      const favoritesAfter = (await host.provider.getChildren(groupsAfter[1]!)) as Extract<
        TaskExplorerNode,
        { kind: 'task' }
      >[]
      assert.strictEqual(favoritesAfter.length, 2, '收藏不受清空影响')
    } finally {
      host.dispose()
    }
  })

  test('真实运行 → 三处运行态一致（转圈）→ 真实停止 → 状态恢复', async function (this: Mocha.Context): Promise<void> {
    this.timeout(30000)
    const host = makeHostTaskProvider()
    try {
      const runStop = (await e2eEntries()).find((entry) => entry.label === 'e2e-run-stop')!
      assert.ok(runStop, '长驻任务应被发现')
      host.usage.addFavorite(runStop.ref)

      let startFired = false
      const startSub = vscode.tasks.onDidStartTask((event) => {
        if (event.execution.task.name === runStop.label) {
          startFired = true
        }
      })
      try {
        // 经扩展真实命令运行（executeTask + recordRun 全链路）
        await vscode.commands.executeCommand('extStarter.runWorkspaceTask', runStop.task)
        await vi_waitFor(() => startFired, '任务开始事件')
        await vi_waitFor(
          () => vscode.tasks.taskExecutions.some((e) => e.task.name === runStop.label),
          '任务出现在执行列表'
        )

        // 两处运行态一致：工作区任务 + 收藏组的同 key 节点都转圈、contextValue 运行中
        const tasksNode = await findTaskNode(host.provider, runStop.label, 'tasks')
        const favoriteNode = await findTaskNode(host.provider, runStop.label, 'favorites')
        assert.ok(tasksNode && favoriteNode, '任务应同时出现在工作区任务与收藏组')
        for (const node of [tasksNode!, favoriteNode!]) {
          const item = host.provider.getTreeItem(node)
          assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'sync~spin')
          assert.strictEqual(item.contextValue, 'workspaceTaskRunningFavorite')
        }

        // 经扩展真实命令停止
        let endFired = false
        const endSub = vscode.tasks.onDidEndTask((event) => {
          if (event.execution.task.name === runStop.label) {
            endFired = true
          }
        })
        try {
          await vscode.commands.executeCommand('extStarter.stopWorkspaceTask', runStop.task)
          await vi_waitFor(() => endFired, '任务结束事件')
          await vi_waitFor(
            () => !vscode.tasks.taskExecutions.some((e) => e.task.name === runStop.label),
            '执行列表清空'
          )
        } finally {
          endSub.dispose()
        }

        // 状态恢复：非运行图标按类型回落（process → gear）
        const restored = await findTaskNode(host.provider, runStop.label, 'favorites')
        assert.ok(restored)
        const restoredItem = host.provider.getTreeItem(restored!)
        assert.strictEqual((restoredItem.iconPath as vscode.ThemeIcon).id, 'gear')
        assert.strictEqual(restoredItem.contextValue, 'workspaceTaskFavorite')
      } finally {
        startSub.dispose()
      }
    } finally {
      host.dispose()
    }
  })

  test('定位到 tasks.json 行：注释噪声不误命中，选中 label 键所在行', async function (this: Mocha.Context): Promise<void> {
    this.timeout(20000)
    const locate = (await e2eEntries()).find((entry) => entry.label === 'e2e-locate')!
    assert.ok(locate, '定位目标任务应被发现')

    await vscode.commands.executeCommand('extStarter.locateTaskInTasksJson', locate.task)
    const editor = vscode.window.activeTextEditor
    assert.ok(editor, '定位应打开编辑器')
    assert.strictEqual(editor.document.uri.fsPath.toLowerCase(), TASKS_JSON_PATH.toLowerCase())

    // 选中行 = 真实 label 键所在行（插入的注释噪声行不应命中）
    const content = nodeFs.readFileSync(TASKS_JSON_PATH, 'utf8').split('\n')
    const expectedLine = content.findIndex((line) => line.includes('"label": "e2e-locate"'))
    assert.ok(expectedLine >= 0)
    assert.strictEqual(editor.selection.start.line, expectedLine)
    assert.strictEqual(editor.selection.start.character, content[expectedLine].indexOf('"label"'))
    assert.ok(!content[editor.selection.start.line].includes('decoy'), '不应定位到注释噪声行')
  })
})
suite('全流程真实环境验证（真实编辑器 / 剪贴板 / 文件 / 草稿落盘）', () => {
  /** 打开一个真实文档并把选区定为 (0,0)-(0,len) —— 与用户「选中一段文本」等价。 */
  async function openWithSelection(content: string, end: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'plaintext' })
    const editor = await vscode.window.showTextDocument(doc)
    editor.selection = new vscode.Selection(0, 0, 0, end)
  }

  test('复制选中文本：真编辑器选区 → 真剪贴板（精确内容）', async () => {
    await openWithSelection('hello 世界 123', 5) // 选中 "hello"
    await vscode.commands.executeCommand('extStarter.copySelection')
    assert.strictEqual(await vscode.env.clipboard.readText(), 'hello')
  })

  test('复制文件内容 / 路径：真实临时文件 → 真剪贴板（多选批量）', async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'crud-real-'))
    const fileA = vscode.Uri.file(nodePath.join(dir, 'a.txt'))
    const fileB = vscode.Uri.file(nodePath.join(dir, 'b.md'))
    await vscode.workspace.fs.writeFile(fileA, Buffer.from('内容A', 'utf8'))
    await vscode.workspace.fs.writeFile(fileB, Buffer.from('内容B', 'utf8'))
    try {
      await vscode.commands.executeCommand('extStarter.copyFileContent', fileA)
      assert.strictEqual(await vscode.env.clipboard.readText(), '内容A')

      await vscode.commands.executeCommand('extStarter.copyFileContent', fileA, [fileA, fileB])
      const multi = await vscode.env.clipboard.readText()
      assert.ok(multi.includes(`=== ${fileA.fsPath} ===`), '批量应有路径分隔头')
      assert.ok(multi.includes('内容A') && multi.includes('内容B'))

      await vscode.commands.executeCommand('extStarter.copyFilePath', fileA, [fileA, fileB])
      assert.strictEqual(
        await vscode.env.clipboard.readText(),
        `${fileA.fsPath}
${fileB.fsPath}`
      )
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('草稿箱全流程：选中文本右键 → 真实落盘工作区数据文件 → 追加 → 内容断言', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri
    assert.ok(root, '集成测试宿主应打开工作区（仓库根）')
    const draftsUri = vscode.Uri.joinPath(root, '.vscode/ext-starter.drafts.json')
    // 清场：数据文件与原子写临时残留一并删除，保证「从空草稿箱开始」的真实流程
    for (const name of await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(root, '.vscode')
    )) {
      if (
        name[0] === 'ext-starter.drafts.json' ||
        name[0].startsWith('ext-starter.drafts.json.tmp-')
      ) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, '.vscode', name[0]), {
          recursive: true,
        })
      }
    }

    // 命令为 fire-and-forget（void addSelection().then(...)）：原子写异步完成，
    // 轮询等待数据文件生成（真实用户视角 = 看到成功提示后数据已落盘）
    const waitForDrafts = async (): Promise<string> => {
      const startedAt = Date.now()
      for (;;) {
        try {
          return Buffer.from(await vscode.workspace.fs.readFile(draftsUri)).toString('utf8')
        } catch {
          if (Date.now() - startedAt > 5000) {
            throw new Error('草稿数据文件未在 5s 内生成（draftSelection 异步写失败）')
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
    }

    await openWithSelection('草稿内容-全流程验证', 12) // 选中前 12 字符
    await vscode.commands.executeCommand('extStarter.draftSelection')
    const raw = await waitForDrafts()
    const persisted = JSON.parse(raw) as {
      schemaVersion: number
      entries: { kind: string; title: string; detail: string }[]
    }
    assert.strictEqual(persisted.schemaVersion, 1)
    assert.ok(persisted.entries.length >= 1, '落盘应产生草稿条目')
    const latest = persisted.entries[0]
    assert.strictEqual(latest.kind, 'selection')
    assert.ok(latest.title.includes('草稿内容'), `标题应含选中摘要（实际：${latest.title}）`)

    // 追加流程：再登记一次 → 追加到最近草稿 → detail 增长。
    // 文件已存在，普通读取会立刻命中追加前的旧内容——按条件轮询到追加落盘为止
    await openWithSelection('追加线索-XYZ', 8)
    const appendResult = (await vscode.commands.executeCommand(
      'extStarter.appendDraftSelection'
    )) as { ok?: boolean; reason?: string; appended?: boolean } | undefined
    assert.ok(appendResult?.ok, `追加命令应成功（返回：${JSON.stringify(appendResult)}）`)
    const startedAt = Date.now()
    for (;;) {
      const data = JSON.parse(await waitForDrafts()) as {
        entries: { detail: string }[]
      }
      if (data.entries[0]?.detail?.includes('追加线索-XYZ')) {
        break
      }
      if (Date.now() - startedAt > 5000) {
        assert.fail('追加未在 5s 内写入最近草稿 detail')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // 测试卫生：清掉本次产生的数据文件与临时残留（gitignore 已覆盖，不影响仓库状态）
    for (const name of await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(root, '.vscode')
    )) {
      if (
        name[0] === 'ext-starter.drafts.json' ||
        name[0].startsWith('ext-starter.drafts.json.tmp-')
      ) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, '.vscode', name[0]), {
          recursive: true,
        })
      }
    }
  })

  test('任务管理弹框：命令打开面板；任务刷新命令可执行', async () => {
    await vscode.commands.executeCommand('extStarter.openTaskManager')
    // 面板创建是异步装配（createOrShow → open() 未被命令 await）：
    // 若此前的面板已被关闭，这里是全新创建，必须轮询等待标签页出现
    const hasPanel = (): boolean =>
      vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .some((tab) => (tab.label ?? '').includes('任务管理'))
    await vi_tabWait(hasPanel)
    assert.ok(hasPanel(), '弹框面板应已打开')
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.refreshTaskManager')
    })
  })
})

suite('收藏夹（v3.4 集成冒烟）', () => {
  test('8 条收藏夹命令全部注册', async () => {
    const commands = new Set(await vscode.commands.getCommands())
    for (const id of [
      'extStarter.addFavorite',
      'extStarter.quickOpenFavorites',
      'extStarter.openFavorite',
      'extStarter.revealFavorite',
      'extStarter.copyFavoritePath',
      'extStarter.renameFavorite',
      'extStarter.removeFavorite',
      'extStarter.openFavoritesDataFile',
    ]) {
      assert.ok(commands.has(id), `命令未注册：${id}`)
    }
  })

  test('收藏夹视图存在且命令可执行（真实宿主出现视图容器分组）', async () => {
    // 视图存在性以清单一致性与激活无错为前提；此处验证命令面真实可执行
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.quickOpenFavorites')
    })
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.addFavorite')
    })
  })
})

suite('快捷命令（v3.5 集成冒烟）', () => {
  test('13 条快捷命令命令全部注册', async () => {
    const commands = new Set(await vscode.commands.getCommands())
    for (const id of [
      'extStarter.addQuickCommand',
      'extStarter.captureTerminalSelection',
      'extStarter.quickRunCommands',
      'extStarter.executeQuickCommand',
      'extStarter.editQuickCommand',
      'extStarter.renameQuickCommand',
      'extStarter.moveQuickCommandToGroup',
      'extStarter.copyQuickCommand',
      'extStarter.removeQuickCommand',
      'extStarter.createQuickCommandGroup',
      'extStarter.renameQuickCommandGroup',
      'extStarter.removeQuickCommandGroup',
      'extStarter.openQuickCommandsDataFile',
    ]) {
      assert.ok(commands.has(id), `命令未注册：${id}`)
    }
  })

  test('快捷命令空态安全路径可执行（quickRunCommands）', async () => {
    // 只执行空态即返回的命令；addQuickCommand / captureTerminalSelection 均会在
    // 真实宿主弹出输入框阻塞等待，不入冒烟（注册完整性由上一用例覆盖）
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.quickRunCommands')
    })
  })
})

suite('书签（v3.6 集成冒烟）', () => {
  test('8 条书签命令全部注册', async () => {
    const commands = new Set(await vscode.commands.getCommands())
    for (const id of [
      'extStarter.toggleBookmark',
      'extStarter.jumpToNextBookmark',
      'extStarter.jumpToPreviousBookmark',
      'extStarter.quickOpenBookmarks',
      'extStarter.jumpToBookmark',
      'extStarter.removeBookmark',
      'extStarter.clearBookmarks',
      'extStarter.openBookmarksDataFile',
    ]) {
      assert.ok(commands.has(id), `命令未注册：${id}`)
    }
  })

  test('书签空态安全路径可执行（quickOpenBookmarks）', async () => {
    // 只执行空态即返回的命令；toggleBookmark 需要活动编辑器、clearBookmarks 会弹
    // 模态确认，均不入冒烟（注册完整性由上一用例覆盖）
    await assert.doesNotReject(async () => {
      await vscode.commands.executeCommand('extStarter.quickOpenBookmarks')
    })
  })
})
