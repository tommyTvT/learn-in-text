<script setup>
import { onLaunch, onShow } from '@dcloudio/uni-app'
import { useWordStore } from './stores/word'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import { startAutoSync, requestSync } from './services/autoSync'
import { dbReady } from './services/db'

onLaunch(() => {
  // 实例化 settings store：loadSettings 内部会立即 applyTheme，
  // 让主题在页面渲染前写入 documentElement，避免首屏闪烁
  const settingsStore = useSettingsStore()
  const wordStore = useWordStore()
  const auth = useAuthStore()

  // uni-app 构建不支持顶层 await，db.js 的 ensureSchema 以 promise 形式导出，
  // 在应用启动处等待其完成后再触发数据读取与同步
  dbReady
    .then(() => wordStore.fetchMarkedWords())
    .catch((e) => console.error('启动初始化失败:', e))
  // 恢复登录会话；恢复完成后补一次同步，避免慢网络下 boot 同步因会话未恢复被跳过
  auth.restoreSession().then(() => requestSync())
  // 启动后台自动云同步（boot 同步在渲染完成后延迟执行）
  startAutoSync()
})

// 应用切回前台时触发一次同步（页面级切换由 PageLayout 的 onShow 触发）
onShow(() => {
  requestSync()
})
</script>

<style></style>
