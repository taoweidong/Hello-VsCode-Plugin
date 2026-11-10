import * as vscode from 'vscode'
import type {
  QuickCommandGroup,
  QuickCommandItem,
  QuickCommandsService,
} from '../features/quickCommands/quickCommandsService'
import { readTerminalSelectionViaClipboard } from '../features/quickCommands/terminalSelection'
import { COMMAND } from '../constants'
import { type CommandRegistrar, showError } from './shared'

/**
 * 快捷命令场景命令分组（v3.5，16 方案）——12 条命令的薄壳，全部委托 QuickCommandsService。
 *
 * - addQuickCommand：InputBox 命令文本 → 别名（默认首词）→ QuickPick 选分组（可新建）；
 * - captureTerminalSelection：活动终端 → 剪贴板桥接读选区（16 方案 §4.2），
 *   无终端/无选区/桥接失败一律降级粘贴 InputBox，绝不抛错给用户；
 * - quickRunCommands：QuickPick 全量命令（分组 Separator 分节），回车即在终端执行；
 * - 带参命令（execute/edit/rename/move/copy/remove + 分组两个）无参调用只提示不抛错。
 */

export interface QuickCommandsCommandDeps {
  quickCommands: QuickCommandsService
}

function isQuickCommandItem(value: unknown): value is QuickCommandItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { command?: unknown }).command === 'string'
  )
}

function isQuickCommandGroup(value: unknown): value is QuickCommandGroup {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { command?: unknown }).command !== 'string'
  )
}

function requireItem(value: unknown, action: string): QuickCommandItem | undefined {
  if (isQuickCommandItem(value)) {
    return value
  }
  void vscode.window.showInformationMessage(`请从「快捷命令」视图${action}。`)
  return undefined
}

function requireGroup(value: unknown, action: string): QuickCommandGroup | undefined {
  if (isQuickCommandGroup(value)) {
    return value
  }
  void vscode.window.showInformationMessage(`请从「快捷命令」视图的分组节点${action}。`)
  return undefined
}

interface GroupPickItem extends vscode.QuickPickItem {
  groupId?: string | null
  create?: boolean
}

/**
 * 分组选择 QuickPick：分组列表（Separator 分节）+ 未分组 + 可选「新建分组…」。
 * 返回 undefined = 用户取消；否则 { groupId }（null = 未分组）。
 */
async function pickGroup(
  quickCommands: QuickCommandsService,
  options: { allowCreate: boolean }
): Promise<{ groupId: string | null } | undefined> {
  const items: GroupPickItem[] = []
  const groups = quickCommands.listGroups()
  if (groups.length > 0) {
    items.push({ label: '分组', kind: vscode.QuickPickItemKind.Separator })
    for (const group of groups) {
      items.push({ label: group.name, groupId: group.id })
    }
  }
  items.push({ label: '未分组', kind: vscode.QuickPickItemKind.Separator })
  items.push({ label: '未分组', groupId: null })
  if (options.allowCreate) {
    items.push({ label: '$(add) 新建分组…', create: true })
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择分组…' })
  if (!picked) {
    return undefined
  }
  const pick = picked as GroupPickItem
  if (pick.create) {
    const name = await vscode.window.showInputBox({ prompt: '新分组名称' })
    if (name === undefined || name.trim().length === 0) {
      return undefined
    }
    const result = await quickCommands.createGroup(name)
    if (result.status === 'created') {
      return { groupId: result.group.id }
    }
    if (result.status === 'duplicate') {
      void vscode.window.showInformationMessage(`分组「${result.existing.name}」已存在，直接使用。`)
      return { groupId: result.existing.id }
    }
    void vscode.window.showWarningMessage('分组数量已达上限（50 个）。')
    return undefined
  }
  return { groupId: pick.groupId ?? null }
}

/** 别名 + 分组两步收集并入库（新增与捕获共用；command 由调用方先行取得）。 */
async function promptAndAdd(
  quickCommands: QuickCommandsService,
  command: string
): Promise<void> {
  const alias = await vscode.window.showInputBox({
    prompt: '快捷命令别名（留空使用命令首词）',
    value: command.trim().split(/\s+/)[0]?.slice(0, 20) ?? '',
  })
  if (alias === undefined) {
    return
  }
  const group = await pickGroup(quickCommands, { allowCreate: true })
  if (group === undefined) {
    return
  }
  try {
    const result = await quickCommands.addCommand({ command, name: alias, groupId: group.groupId })
    if (result.status === 'added') {
      void vscode.window.showInformationMessage(`已收藏快捷命令「${result.item.name}」。`)
    } else if (result.status === 'duplicate') {
      void vscode.window.showInformationMessage(
        `已存在相同命令：「${result.existing.name}」（不重复收藏）。`
      )
    } else if (result.status === 'cap') {
      void vscode.window.showWarningMessage('快捷命令数量已达上限（200 条）。')
    } else {
      void vscode.window.showWarningMessage('命令文本不能为空。')
    }
  } catch (err) {
    showError(err)
  }
}

/** QuickPick 快速执行的条目形态（分组 Separator 分节 + 未分组节）。 */
interface RunPickItem extends vscode.QuickPickItem {
  item?: QuickCommandItem
}

function buildRunItems(quickCommands: QuickCommandsService): RunPickItem[] {
  const items: RunPickItem[] = []
  const commands = quickCommands.listCommands()
  for (const group of quickCommands.listGroups()) {
    const children = commands.filter((entry) => entry.groupId === group.id)
    if (children.length === 0) {
      continue
    }
    items.push({ label: group.name, kind: vscode.QuickPickItemKind.Separator })
    items.push(...children.map((item) => runItemOf(item, group.name)))
  }
  const ungrouped = commands.filter((entry) => entry.groupId === null)
  if (ungrouped.length > 0) {
    items.push({ label: '未分组', kind: vscode.QuickPickItemKind.Separator })
    items.push(...ungrouped.map((item) => runItemOf(item, '未分组')))
  }
  return items
}

function runItemOf(item: QuickCommandItem, groupName: string): RunPickItem {
  return {
    label: item.name,
    description: item.command.replace(/\s+/g, ' ').trim(),
    detail: `${groupName} · 已执行 ${item.useCount ?? 0} 次`,
    item,
  }
}

export function registerQuickCommandsCommands(
  register: CommandRegistrar,
  deps: QuickCommandsCommandDeps
): void {
  const { quickCommands } = deps

  register(COMMAND.addQuickCommand, async () => {
    const command = await vscode.window.showInputBox({
      prompt: '要收藏的命令（支持多行）',
      placeHolder: '例如：git push origin main',
    })
    if (command === undefined) {
      return
    }
    if (command.trim().length === 0) {
      void vscode.window.showWarningMessage('命令文本不能为空。')
      return
    }
    await promptAndAdd(quickCommands, command)
  })

  register(COMMAND.captureTerminalSelection, async () => {
    if (!vscode.window.activeTerminal) {
      void vscode.window.showInformationMessage(
        '没有活动的终端：请先打开终端并选中要收藏的命令，或直接手动新增。'
      )
      return
    }
    const selection = await readTerminalSelectionViaClipboard()
    if (selection === undefined) {
      // 降级：粘贴输入框（16 方案 §4.2——不抛错，给可操作出路）
      const pasted = await vscode.window.showInputBox({
        prompt: '收藏终端选中命令',
        placeHolder: '未读到终端选区：请在终端选中命令后重试，或直接粘贴命令',
      })
      if (pasted === undefined || pasted.trim().length === 0) {
        return
      }
      await promptAndAdd(quickCommands, pasted)
      return
    }
    await promptAndAdd(quickCommands, selection)
  })

  register(COMMAND.quickRunCommands, async () => {
    if (quickCommands.listCommands().length === 0) {
      void vscode.window.showInformationMessage('快捷命令为空：先新增或从终端收藏一条命令。')
      return
    }
    const picked = (await vscode.window.showQuickPick(buildRunItems(quickCommands), {
      placeHolder: '执行快捷命令…',
      matchOnDescription: true,
    })) as RunPickItem | undefined
    if (!picked?.item) {
      return
    }
    try {
      await quickCommands.execute(picked.item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.executeQuickCommand, async (arg?: unknown) => {
    const item = requireItem(arg, '执行快捷命令')
    if (!item) {
      return
    }
    try {
      await quickCommands.execute(item)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.editQuickCommand, async (arg?: unknown) => {
    const item = requireItem(arg, '编辑命令文本')
    if (!item) {
      return
    }
    const command = await vscode.window.showInputBox({
      prompt: '新的命令文本',
      value: item.command,
    })
    if (command === undefined) {
      return
    }
    try {
      const result = await quickCommands.updateCommandText(item.id, command)
      if (result === 'duplicate') {
        void vscode.window.showInformationMessage('已存在相同命令，不重复收藏。')
      } else if (result === 'empty') {
        void vscode.window.showWarningMessage('命令文本不能为空。')
      } else if (result === 'notfound') {
        void vscode.window.showInformationMessage('快捷命令已不存在。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.renameQuickCommand, async (arg?: unknown) => {
    const item = requireItem(arg, '重命名别名')
    if (!item) {
      return
    }
    const name = await vscode.window.showInputBox({
      prompt: '新的快捷命令别名',
      value: item.name,
    })
    if (name === undefined) {
      return
    }
    try {
      const renamed = await quickCommands.renameCommand(item.id, name)
      if (!renamed) {
        void vscode.window.showInformationMessage('别名不能为空，或快捷命令已不存在。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.moveQuickCommandToGroup, async (arg?: unknown) => {
    const item = requireItem(arg, '移动到分组')
    if (!item) {
      return
    }
    const group = await pickGroup(quickCommands, { allowCreate: true })
    if (group === undefined) {
      return
    }
    try {
      const moved = await quickCommands.moveCommandToGroup(item.id, group.groupId)
      if (!moved) {
        void vscode.window.showInformationMessage('分组不存在，或快捷命令已不存在。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.copyQuickCommand, async (arg?: unknown) => {
    const item = requireItem(arg, '复制命令文本')
    if (!item) {
      return
    }
    try {
      await vscode.env.clipboard.writeText(item.command)
      void vscode.window.showInformationMessage(`已复制命令：${item.command}`)
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.removeQuickCommand, async (arg?: unknown) => {
    const item = requireItem(arg, '删除快捷命令')
    if (!item) {
      return
    }
    try {
      const removed = await quickCommands.removeCommand(item.id)
      if (removed) {
        void vscode.window.showInformationMessage(`已删除快捷命令「${item.name}」。`)
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.createQuickCommandGroup, async () => {
    const name = await vscode.window.showInputBox({ prompt: '新分组名称' })
    if (name === undefined || name.trim().length === 0) {
      return
    }
    try {
      const result = await quickCommands.createGroup(name)
      if (result.status === 'created') {
        void vscode.window.showInformationMessage(`已创建分组「${result.group.name}」。`)
      } else if (result.status === 'duplicate') {
        void vscode.window.showInformationMessage(`分组「${result.existing.name}」已存在。`)
      } else {
        void vscode.window.showWarningMessage('分组数量已达上限（50 个）。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.renameQuickCommandGroup, async (arg?: unknown) => {
    const group = requireGroup(arg, '重命名分组')
    if (!group) {
      return
    }
    const name = await vscode.window.showInputBox({
      prompt: '新的分组名称',
      value: group.name,
    })
    if (name === undefined) {
      return
    }
    try {
      const result = await quickCommands.renameGroup(group.id, name)
      if (result === 'duplicate') {
        void vscode.window.showInformationMessage('已存在同名分组。')
      } else if (result === 'notfound') {
        void vscode.window.showInformationMessage('分组不存在，或名称为空。')
      }
    } catch (err) {
      showError(err)
    }
  })

  register(COMMAND.removeQuickCommandGroup, async (arg?: unknown) => {
    const group = requireGroup(arg, '删除分组')
    if (!group) {
      return
    }
    const count = quickCommands.listCommands().filter((entry) => entry.groupId === group.id).length
    const answer = await vscode.window.showWarningMessage(
      count > 0
        ? `删除分组「${group.name}」？组内 ${count} 条命令将回落到未分组。`
        : `删除空分组「${group.name}」？`,
      { modal: true },
      '删除'
    )
    if (answer !== '删除') {
      return
    }
    try {
      const removed = await quickCommands.removeGroup(group.id)
      if (removed) {
        void vscode.window.showInformationMessage(`已删除分组「${group.name}」。`)
      }
    } catch (err) {
      showError(err)
    }
  })
}
