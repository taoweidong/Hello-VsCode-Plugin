<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type {
  CommandHistoryWire,
  FieldDef,
  SerialPortBrief,
  SerialServerWire,
} from '../../protocol'
import type { FormField } from '../../formSchema'
import { schemaDefaults, toFormFields } from '../../components/fieldAdapter'
import { useConsolePage, type ConsoleLinkState } from '../../composables/useConsolePage'
import { useTwoStepConfirm } from '../../composables/useTwoStepConfirm'
import { useVsCodeApi } from '../../shared/useVsCodeApi'
import AppShell from '../../ui/AppShell.vue'
import VBadge from '../../ui/VBadge.vue'
import VButton from '../../ui/VButton.vue'
import CommandInput from './components/CommandInput.vue'
import ConsoleOutput, { type OutputBlock } from './components/ConsoleOutput.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import ServerForm from './components/ServerForm.vue'
import ServerList from './components/ServerList.vue'

/**
 * 串口控制台页面：左栏服务器管理（列表 + Schema 表单），右栏控制台
 * （状态条 + 实时输出 + 命令输入 + 历史命令）。全部状态经 useConsolePage
 * 与宿主互通；表单草稿与选中服务器经 webview state 持久化。
 */

/** 输出缓冲上限：超出裁剪最旧块（防长会话内存膨胀）。 */
const MAX_OUTPUT_BLOCKS = 2_000

const schema = ref<FormField[]>([])
const servers = ref<SerialServerWire[]>([])
const history = ref<CommandHistoryWire[]>([])
const ports = ref<SerialPortBrief[]>([])
const output = ref<OutputBlock[]>([])
const link = reactive<ConsoleLinkState>({ serverId: null, state: 'disconnected' })
const linkError = ref('')

const selectedServerId = ref<string | undefined>(undefined)
const editingId = ref<string | undefined>(undefined)
const formValue = ref<Record<string, unknown>>({})
const fieldErrors = ref<Record<string, string>>({})
const saving = ref(false)
const sending = ref(false)
const command = ref('')

/** 本地回显块的 seq 序号（负数，避免与宿主 serialData 的正序冲突）。 */
let echoSeq = 0
/** 保存后等待 serialServers 推送时复位表单（区分「自己的保存」与外部列表刷新）。 */
let awaitingSaveReset = false
/** 编辑态重置的两段式布防确认（Esc / 重置按钮共用同一布防态）。 */
const resetConfirm = useTwoStepConfirm()

const connected = computed(() => link.state === 'connected')
const connecting = computed(() => link.state === 'connecting')
const activeServer = computed(
  () => servers.value.find((server) => server.id === link.serverId) ?? undefined
)
const editing = computed(() => editingId.value !== undefined)
const historyCommands = computed(() => history.value.map((entry) => entry.command))

const statusText = computed(() => {
  if (connecting.value) return `连接中${activeServer.value ? `：${activeServer.value.name}` : ''}…`
  if (connected.value) return `已连接：${activeServer.value?.name ?? link.serverId ?? ''}`
  if (link.state === 'error') return '连接出错'
  return '未连接'
})

const { initialized, post } = useConsolePage({
  onInit(schemaDefs: FieldDef[], extra, persisted) {
    schema.value = toFormFields(schemaDefs)
    formValue.value = schemaDefaults(schema.value)
    servers.value = extra.servers
    history.value = extra.history
    // 恢复草稿（窗口重载 / 面板复用）：草稿优先于宿主预选
    const saved = persisted as { draft?: Record<string, unknown>; selectedServerId?: string } | null
    if (saved && typeof saved === 'object') {
      if (saved.draft && typeof saved.draft === 'object') {
        formValue.value = { ...formValue.value, ...saved.draft, password: '' }
      }
      if (typeof saved.selectedServerId === 'string') {
        selectedServerId.value = saved.selectedServerId
      }
    }
    if (extra.initialServerId) {
      selectedServerId.value = extra.initialServerId
      post({ type: 'serialConnect', serverId: extra.initialServerId })
    }
  },
  onServers(next) {
    servers.value = next
    // 自己保存成功：复位表单为新增态（密码永不留存）
    if (awaitingSaveReset) {
      awaitingSaveReset = false
      saving.value = false
      editingId.value = undefined
      formValue.value = { ...schemaDefaults(schema.value) }
    }
    if (selectedServerId.value && !next.some((s) => s.id === selectedServerId.value)) {
      selectedServerId.value = undefined
    }
  },
  onLinkState(payload) {
    link.serverId = payload.serverId
    link.state = payload.state
    linkError.value = payload.error ?? ''
    if (payload.state === 'error' && payload.error) {
      appendOutput({ seq: nextEchoSeq(), text: `[连接错误] ${payload.error}\n`, kind: 'echo' })
    }
  },
  onData(text, seq) {
    appendOutput({ seq, text })
  },
  onPorts(next) {
    ports.value = next
  },
  onHistory(entries) {
    history.value = entries
  },
  onError(message, field) {
    saving.value = false
    sending.value = false
    // 保存失败：本次保存的复位期望作废——随后的外部 servers 推送不得误清编辑表单
    awaitingSaveReset = false
    if (field) {
      fieldErrors.value = { ...fieldErrors.value, [field]: message }
    } else {
      appendOutput({ seq: nextEchoSeq(), text: `[错误] ${message}\n`, kind: 'echo' })
    }
  },
})

function nextEchoSeq(): number {
  echoSeq -= 1
  return echoSeq
}

function appendOutput(block: OutputBlock): void {
  output.value.push(block)
  if (output.value.length > MAX_OUTPUT_BLOCKS) {
    output.value.splice(0, output.value.length - MAX_OUTPUT_BLOCKS)
  }
}

// ---------------- 服务器管理 ----------------

function onConnectClick(id: string): void {
  const target = connected.value && link.serverId === id
  if (target) {
    post({ type: 'serialDisconnect' })
    return
  }
  selectedServerId.value = id
  post({ type: 'serialConnect', serverId: id })
}

function onEdit(id: string): void {
  const server = servers.value.find((item) => item.id === id)
  if (!server) return
  selectedServerId.value = id
  editingId.value = id
  fieldErrors.value = {}
  resetConfirm.disarm()
  formValue.value = {
    id: server.id,
    name: server.name,
    serialPath: server.serialPath,
    baudRate: String(server.baudRate),
    dataBits: String(server.dataBits),
    stopBits: String(server.stopBits),
    parity: server.parity,
    flowControl: server.flowControl,
    lineEnding: server.lineEnding,
    autoLogin: server.autoLogin,
    username: server.username,
    password: '',
    description: server.description,
  }
}

function onFormUpdate(value: Record<string, unknown>): void {
  formValue.value = value
  if (Object.keys(fieldErrors.value).length > 0) {
    fieldErrors.value = {}
  }
}

function onReset(): void {
  // 编辑态重置前两段式布防确认（P2-F3）：Esc / 重置按钮都会丢弃已编辑字段，
  // 首次触发仅布防（3s 内再触发才执行）；浏览器模态 confirm 在 webview 沙箱下
  // 恒被忽略（第五轮评估 P0），故改页内布防。新增态无编辑内容，保持直接重置
  if (editingId.value !== undefined && !resetConfirm.confirm('reset')) {
    return
  }
  resetConfirm.disarm()
  editingId.value = undefined
  fieldErrors.value = {}
  formValue.value = schemaDefaults(schema.value)
}

function onSave(): void {
  if (saving.value) return
  const { password, ...draft } = formValue.value
  saving.value = true
  awaitingSaveReset = true
  fieldErrors.value = {}
  post({
    type: 'serialServerSave',
    draft,
    ...(typeof password === 'string' && password.length > 0 ? { password } : {}),
  })
}

function onDelete(id: string): void {
  post({ type: 'serialServerDelete', id })
}

// ---------------- 命令下发 ----------------

function onSend(value: string): void {
  if (!connected.value || value.trim().length === 0) return
  sending.value = true
  appendOutput({ seq: nextEchoSeq(), text: `> ${value.trim()}\n`, kind: 'echo' })
  post({ type: 'serialSend', command: value })
  // 发送完成（历史推送到达）即解除在途态
  setTimeout(() => {
    sending.value = false
  }, 200)
}

function onHistoryFill(value: string): void {
  command.value = value
}

function onHistorySend(value: string): void {
  onSend(value)
}

// ---------------- 持久化（草稿 + 选中服务器） ----------------

const api = useVsCodeApi()
let persistTimer: ReturnType<typeof setTimeout> | undefined

watch(
  [formValue, selectedServerId],
  () => {
    if (!initialized.value) return
    if (persistTimer !== undefined) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      const { password: _password, ...draft } = formValue.value
      api.setState?.({ draft, selectedServerId: selectedServerId.value ?? null })
    }, 500)
  },
  { deep: true }
)
</script>

<template>
  <AppShell title="串口控制台" subtitle="服务器串口命令下发与实时输出" width="full">
    <div class="console" :class="{ 'console--ready': initialized }">
      <aside class="console__side">
        <div class="console__side-section">
          <ServerList
            :servers="servers"
            :selected-id="selectedServerId"
            :active-server-id="link.serverId"
            :link-state="link.state"
            @select="selectedServerId = $event"
            @connect="onConnectClick"
            @edit="onEdit"
            @delete="onDelete"
          ></ServerList>
        </div>
        <div class="console__side-section console__side-section--form">
          <ServerForm
            :schema="schema"
            :model-value="formValue"
            :errors="fieldErrors"
            :ports="ports"
            :editing="editing"
            :saving="saving"
            :reset-armed="resetConfirm.isArmed('reset')"
            @update:model-value="onFormUpdate"
            @submit="onSave"
            @reset="onReset"
            @detect="post({ type: 'serialPortsRequest' })"
          ></ServerForm>
        </div>
      </aside>

      <section class="console__main">
        <div class="console__statusbar">
          <VBadge :label="connected ? 'ON' : connecting ? '…' : 'OFF'"></VBadge>
          <span
            class="console__status-text"
            :class="{ 'console__status-text--error': link.state === 'error' }"
          >
            {{ statusText }}
          </span>
          <span v-if="activeServer" class="console__status-meta">
            {{ activeServer.serialPath }} · {{ activeServer.baudRate }}
          </span>
          <span class="console__status-actions">
            <VButton
              v-if="connected"
              variant="secondary"
              icon="close"
              title="断开串口"
              @click="post({ type: 'serialDisconnect' })"
            >
              断开
            </VButton>
          </span>
        </div>

        <ConsoleOutput :blocks="output" @clear="output = []"></ConsoleOutput>

        <CommandInput
          v-model="command"
          :connected="connected"
          :sending="sending"
          :history-commands="historyCommands"
          @send="onSend"
        ></CommandInput>

        <HistoryPanel
          :entries="history"
          @fill="onHistoryFill"
          @send="onHistorySend"
          @remove="post({ type: 'commandHistoryRemove', id: $event })"
          @clear="post({ type: 'commandHistoryClear' })"
        ></HistoryPanel>
      </section>
    </div>
  </AppShell>
</template>

<style scoped>
.console {
  display: flex;
  gap: var(--ui-space-4);
  align-items: stretch;
  min-height: 60vh;
}

.console__side {
  width: var(--ui-console-side-width);
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-3);
}

.console__side-section {
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  padding: var(--ui-space-3);
}

.console__side-section--form {
  max-height: 50vh;
  overflow: auto;
}

.console__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ui-space-3);
}

.console__statusbar {
  display: flex;
  align-items: center;
  gap: var(--ui-space-2);
}

.console__status-text {
  color: var(--ui-fg);
  font-weight: 600;
}

.console__status-text--error {
  color: var(--ui-error);
}

.console__status-meta {
  color: var(--ui-fg-muted);
}

.console__status-actions {
  margin-left: auto;
}
</style>
