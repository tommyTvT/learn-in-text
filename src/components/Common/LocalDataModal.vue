<script setup>
import { ref, computed } from 'vue'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { useWordStore } from '../../stores/word'
import { syncNow } from '../../services/sync'
import { setLastSyncState, resetLastSyncState, syncAfterLogin } from '../../services/autoSync'
import { getLocalDataOwner, clearLocalData, setLocalDataOwner, downloadFullBackup } from '../../services/localData'
import { LoaderCircle } from 'lucide-vue-next'

defineProps({
  open: { type: Boolean, default: false },
  stats: { type: Object, required: true }
})
const emit = defineEmits(['done', 'cancel'])

const auth = useAuthStore()
const settingsStore = useSettingsStore()
const wordStore = useWordStore()

const busy = ref(false)
const busyText = ref('')
const error = ref('')

const accountLabel = computed(() => (auth.username ? `@${auth.username}` : '当前登录的账号'))
const ownerText = computed(() => {
  const owner = getLocalDataOwner()
  return owner ? `属于上次登录的账号 @${owner}（登出时残留）` : '是在未登录的离线状态下创建的'
})

async function finishClear() {
  await clearLocalData()
  setLocalDataOwner(auth.username)
  // 本地数据已清空：设置一并重置为默认，再拉取当前账号的云端设置（无则首推默认）
  await settingsStore.resetSettings()
  await auth.syncSettingsAfterLogin()
  // 重置同步状态；本地已清空 → 立即从云端拉取该账号数据，不等定时任务
  resetLastSyncState()
  await syncAfterLogin()
  // 强制刷新内存中的词库缓存
  wordStore.fetchMarkedWords(true)
  emit('done')
}

async function handleMerge() {
  if (busy.value) return
  busy.value = true
  busyText.value = '正在同步到云端...'
  error.value = ''
  try {
    setLocalDataOwner(auth.username)
    // 合并语义包含设置：本地设置按 LWW 与该账号云端设置合并（云端无记录则上传本地）
    await auth.syncSettingsAfterLogin()
    const result = await syncNow()
    setLastSyncState(true, result.message, result.detail, 'manual')
    emit('done')
  } catch (e) {
    setLastSyncState(false, e.message)
    error.value = `同步失败：${e.message}。本地数据已保留，可重试，或稍后由自动同步完成`
  } finally {
    busy.value = false
  }
}

async function handleExportClear() {
  if (busy.value) return
  busy.value = true
  busyText.value = '正在导出备份...'
  error.value = ''
  try {
    await downloadFullBackup(settingsStore.exportSettings())
    await finishClear()
  } catch (e) {
    error.value = '导出失败：' + e.message + '，本地数据已保留，可重试'
  } finally {
    busy.value = false
  }
}

async function handleClear() {
  if (busy.value) return
  if (!confirm('直接清除后本地数据将无法恢复（不影响云端数据）。确定清除吗？')) return
  busy.value = true
  busyText.value = '正在清除本地数据...'
  error.value = ''
  try {
    await finishClear()
  } catch (e) {
    error.value = '清除失败：' + e.message
  } finally {
    busy.value = false
  }
}

async function handleCancel() {
  if (busy.value) return
  busy.value = true
  try {
    await auth.logout()
  } finally {
    busy.value = false
    emit('cancel')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div class="w-full max-w-md bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-200 dark:border-neutral-800 p-5 sm:p-6">
        <h2 class="text-lg font-bold text-gray-900 dark:text-neutral-100">发现本地数据</h2>
        <p class="mt-2 text-sm leading-relaxed text-gray-600 dark:text-neutral-400">
          本设备存有
          <span class="font-medium text-gray-900 dark:text-neutral-100">{{ stats.articles }} 篇文章、{{ stats.words }} 个单词、{{ stats.wordMarks }} 条标记</span>，
          {{ ownerText }}。这些数据不属于 {{ accountLabel }}，请选择处理方式：
        </p>

        <div class="mt-5 space-y-4">
          <div>
            <button
              @click="handleMerge"
              :disabled="busy"
              class="w-full px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
            >
              合并到该账号
            </button>
            <p class="mt-1 text-xs text-gray-500 dark:text-neutral-400">保留本地数据，登录后立即同步上传到该账号的云端</p>
          </div>

          <div>
            <button
              @click="handleExportClear"
              :disabled="busy"
              class="w-full px-4 py-2.5 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              导出备份后清除
            </button>
            <p class="mt-1 text-xs text-gray-500 dark:text-neutral-400">先保存为 JSON 备份文件，再清空本地数据，以全新状态登录</p>
          </div>

          <div>
            <button
              @click="handleClear"
              :disabled="busy"
              class="w-full px-4 py-2.5 rounded-lg border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 font-medium hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              直接清除并登录
            </button>
            <p class="mt-1 text-xs text-gray-500 dark:text-neutral-400">不导出、不合并，直接清空本地数据（不可恢复）</p>
          </div>
        </div>

        <p v-if="busy" class="mt-4 flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400">
          <LoaderCircle class="w-4 h-4 animate-spin" />{{ busyText }}
        </p>
        <p v-if="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>

        <button
          @click="handleCancel"
          :disabled="busy"
          class="mt-5 w-full py-2 text-sm text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 disabled:opacity-60 cursor-pointer"
        >
          取消登录（登出并留在本页）
        </button>
      </div>
    </div>
  </Teleport>
</template>
