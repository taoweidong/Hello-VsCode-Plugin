import * as vscode from 'vscode'
import { COMMAND } from '../../constants'
import type { StepState } from './initService'

const STATUS_ICONS: Record<StepState['status'], string> = {
  idle: 'circle-large-outline',
  running: 'sync~spin',
  done: 'check',
  failed: 'error',
}

const STATUS_LABEL: Record<StepState['status'], string> = {
  idle: '待执行',
  running: '执行中',
  done: '完成',
  failed: '失败',
}

/**
 * 「环境初始化」树视图：初始化步骤清单。
 * 单击步骤即执行该步骤，执行结果（信息/耗时）显示在描述与 tooltip 中——
 * 演示「清单 + 单步动作」模式。
 */
export class InitTreeProvider implements vscode.TreeDataProvider<StepState>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<StepState | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(private readonly getStates: () => StepState[]) {}

  /** InitService 每次状态变化都会调用（extension.ts 订阅后转发）。 */
  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getTreeItem(state: StepState): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(state.title, vscode.TreeItemCollapsibleState.None)
    treeItem.description = state.message
      ? `${STATUS_LABEL[state.status]} · ${state.message}`
      : STATUS_LABEL[state.status]
    treeItem.iconPath = new vscode.ThemeIcon(STATUS_ICONS[state.status])
    treeItem.contextValue = 'initStep'
    treeItem.tooltip = new vscode.MarkdownString(
      `**${state.title}**\n\n${state.description}` +
        (state.message ? `\n\n- 结果：${state.message}` : '') +
        (state.durationMs != null ? `\n- 耗时：${state.durationMs}ms` : '') +
        `\n\n- 单击执行该步骤`
    )
    treeItem.command = {
      command: COMMAND.runInitStep,
      title: '执行初始化步骤',
      arguments: [state.id],
    }
    return treeItem
  }

  async getChildren(): Promise<StepState[]> {
    if (!this.getStates().length) {
      return []
    }
    return this.getStates()
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose()
  }
}
