import { createApp } from 'vue'
// 样式最先引入：组件样式依赖 --ui-* 设计令牌
import '../../ui/tokens.css'
// codicon 字体（图标自绘依赖；字体随 dist 分发，CSP font-src 已授权）
import '@vscode/codicons/dist/codicon.css'
import TaskManagerApp from './App.vue'

createApp(TaskManagerApp).mount('#app')
