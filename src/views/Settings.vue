<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { testConnection } from '../services/ai'
import { exportService } from '../services/db'
import { testConnection as testCloudConnection, syncNow, clearCloud } from '../services/sync'
import { lastSyncState, setLastSyncState } from '../services/autoSync'
import AIConfigModal from '../components/AI/AIConfigModal.vue'

const settingsStore = useSettingsStore()
const authStore = useAuthStore()

const isLoggedIn = computed(() => authStore.isLoggedIn)

const activeProvider = computed(() => settingsStore.activeProvider)
const aiConfigOpen = ref(false)
const testing = ref(false)
const testResult = ref(null)
const exporting = ref(false)
const importing = ref(false)
const showDevOptions = ref(false)
const dataStats = ref(null)

// 云同步状态
const cloudTesting = ref(false)
const cloudSyncing = ref(false)
const cloudClearing = ref(false)
const cloudResult = ref(null)
// 开发者选项中的清除云端数据结果提示
const devCloudResult = ref(null)

// 上次同步状态展示（自动同步或手动同步后都会更新）
const syncStatusText = computed(() => {
  if (!lastSyncState.value) return '尚未同步过'
  const d = new Date(lastSyncState.value.at)
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (lastSyncState.value.success) {
    return `${time} · 同步成功`
  }
  const msg = (lastSyncState.value.message || '同步失败').slice(0, 60)
  return `${time} · 同步失败：${msg}`
})

async function handleTestCloudConnection() {
  cloudTesting.value = true
  cloudResult.value = null
  try {
    cloudResult.value = await testCloudConnection()
  } catch (error) {
    cloudResult.value = { success: false, message: error.message }
  } finally {
    cloudTesting.value = false
  }
}

async function handleSync() {
  cloudSyncing.value = true
  cloudResult.value = null
  try {
    cloudResult.value = await syncNow()
    setLastSyncState(true, cloudResult.value.message, cloudResult.value.detail, 'manual')
  } catch (error) {
    cloudResult.value = { success: false, message: error.message }
    setLastSyncState(false, error.message)
  } finally {
    cloudSyncing.value = false
  }
}

// 设置同步状态
const settingsSyncing = ref(false)
const settingsSyncResult = ref(null)

async function handleSyncSettings() {
  if (!isLoggedIn.value) return
  settingsSyncing.value = true
  settingsSyncResult.value = null
  try {
    // 先推送本地设置到云端（作为最新的），再尝试从云端拉取
    await settingsStore.pushToCloud()
    await settingsStore.syncFromCloud()
    settingsSyncResult.value = { success: true, message: '设置已同步到云端' }
  } catch (error) {
    settingsSyncResult.value = { success: false, message: error.message }
  } finally {
    settingsSyncing.value = false
  }
}

async function handleClearCloud() {
  if (!confirm('确定要清除该用户名在云端的所有数据吗？此操作不可恢复。')) return
  cloudClearing.value = true
  devCloudResult.value = null
  try {
    devCloudResult.value = await clearCloud()
  } catch (error) {
    devCloudResult.value = { success: false, message: error.message }
  } finally {
    cloudClearing.value = false
  }
}

async function handleLogout() {
  if (!confirm('确定要退出登录吗？本地数据不受影响。')) return
  await authStore.logout()
}

async function handleTestConnection() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testConnection()
  } catch (error) {
    testResult.value = { success: false, message: error.message }
  } finally {
    testing.value = false
  }
}

async function exportAllData() {
  exporting.value = true
  try {
    const data = await exportService.exportFull()
    data.settings = settingsStore.exportSettings()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `learn_in_text_backup_${new Date().toISOString().split('T')[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
    alert('导出成功')
  } catch (error) {
    alert('导出失败: ' + error.message)
  } finally {
    exporting.value = false
  }
}

function importAllData(event) {
  const file = event.target.files[0]
  if (!file) return

  if (!confirm('导入将合并现有数据，相同文章和单词会被跳过。确定继续？')) {
    event.target.value = ''
    return
  }

  importing.value = true
  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result)
      if (data.settings) {
        settingsStore.importSettings(data.settings)
      }
      if (data.type === 'full_backup' && data.data) {
        const stats = await exportService.importFull(data)
        alert(`导入完成：新增 ${stats.articles} 篇文章，${stats.words} 个单词，${stats.marks} 条标记，跳过 ${stats.skipped} 篇已存在文章`)
      } else {
        alert('导入完成')
      }
    } catch (error) {
      alert('导入失败: ' + error.message)
    } finally {
      importing.value = false
      event.target.value = ''
    }
  }
  reader.readAsText(file)
}

async function loadStats() {
  try {
    dataStats.value = await exportService.getDataStats()
  } catch (error) {
    console.error('获取数据统计失败:', error)
  }
}

onMounted(() => {
  loadStats()
})
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold text-gray-900 dark:text-neutral-100 mb-2">设置</h1>
      <p class="text-gray-600 dark:text-neutral-400">配置AI接口和其他设置</p>
    </div>

    <!-- 用户信息 -->
    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-4 mb-6">
      <template v-if="isLoggedIn">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-semibold shrink-0">
              {{ authStore.username.charAt(0).toUpperCase() }}
            </div>
            <div>
              <div class="font-medium text-gray-900 dark:text-neutral-100">@{{ authStore.username }}</div>
              <div class="text-xs text-gray-500 dark:text-neutral-400">已登录，云端同步可用</div>
            </div>
          </div>
          <button
            @click="handleLogout"
            class="shrink-0 px-3 py-1.5 text-sm text-gray-600 dark:text-neutral-400 border border-gray-300 dark:border-neutral-700 rounded-md hover:text-red-600 dark:hover:text-red-400 hover:border-red-300 dark:hover:border-red-800 cursor-pointer"
          >
            退出登录
          </button>
        </div>
      </template>
      <template v-else>
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-gray-200 dark:bg-neutral-700 text-gray-500 dark:text-neutral-400 flex items-center justify-center shrink-0">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>
            <div>
              <div class="font-medium text-gray-900 dark:text-neutral-100">未登录</div>
              <div class="text-xs text-gray-500 dark:text-neutral-400">登录后可启用云同步</div>
            </div>
          </div>
          <RouterLink
            to="/login"
            class="shrink-0 px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            登录 / 注册
          </RouterLink>
        </div>
      </template>
    </div>

    <div class="space-y-6">
      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">外观</h2>
        <p class="text-sm text-gray-600 dark:text-neutral-400 mb-4">
          选择界面主题，默认跟随系统偏好
        </p>
        <div class="flex gap-3">
          <button
            v-for="(label, key) in { system: '跟随系统', light: '浅色', dark: '深色' }"
            :key="key"
            @click="settingsStore.theme = key; settingsStore.applyTheme()"
            :class="[
              'flex-1 px-4 py-2.5 rounded-md border text-sm font-medium transition-colors',
              settingsStore.theme === key
                ? 'border-blue-500 bg-blue-50 text-blue-700 ring-2 ring-blue-200 dark:border-neutral-500 dark:bg-neutral-700 dark:text-neutral-100 dark:ring-neutral-500'
                : 'border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'
            ]"
          >
            {{ label }}
          </button>
        </div>
      </div>

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <div class="flex items-center justify-between gap-3 mb-4">
          <div>
            <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100">AI 接口配置</h2>
            <p class="text-sm text-gray-600 dark:text-neutral-400 mt-1">
              支持多个供应商随时切换。配置供应商与模型在弹窗内完成。
            </p>
          </div>
          <button
            @click="aiConfigOpen = true"
            class="shrink-0 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors font-medium"
          >
            配置
          </button>
        </div>

        <div class="space-y-4">
          <!-- 当前激活供应商概览 -->
          <div
            class="rounded-lg border border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-neutral-800/60 p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-xs text-gray-500 dark:text-neutral-400 mb-1">当前使用的供应商</div>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium text-gray-900 dark:text-neutral-100">
                    {{ activeProvider?.name || '未选择' }}
                  </span>
                  <span
                    :class="[
                      'shrink-0 text-xs px-2 py-0.5 rounded-full',
                      activeProvider?.apiKey
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                        : 'bg-gray-100 text-gray-500 dark:bg-neutral-700 dark:text-neutral-400'
                    ]"
                  >
                    {{ activeProvider?.apiKey ? '已配置' : '未配置 Key' }}
                  </span>
                </div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-xs text-gray-500 dark:text-neutral-400 mb-1">当前模型</div>
                <div class="text-sm font-medium text-gray-900 dark:text-neutral-100 max-w-[10rem] sm:max-w-xs truncate">
                  {{ activeProvider?.model || '未设置模型' }}
                </div>
              </div>
            </div>
          </div>

          <div class="flex items-center space-x-3">
            <button
              @click="handleTestConnection"
              :disabled="testing || !settingsStore.aiEndpoint || !settingsStore.aiApiKey"
              class="px-4 py-2 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {{ testing ? '测试中...' : '测试连接' }}
            </button>
            <span class="text-xs text-gray-400 dark:text-neutral-500">
              测试当前所选供应商与模型的连接
            </span>
          </div>

          <div
            v-if="testResult"
            :class="[
              'p-3 rounded-md text-sm',
              testResult.success ? 'bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400' : 'bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400'
            ]"
          >
            {{ testResult.message }}
          </div>
        </div>
      </div>

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">云同步</h2>

        <div class="space-y-4">
          <div v-if="isLoggedIn" class="border-t border-gray-200 dark:border-neutral-800 pt-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300">自动同步</h3>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settingsStore.autoSync"
                @click="settingsStore.autoSync = !settingsStore.autoSync"
                :class="[
                  'relative w-11 h-6 rounded-full transition-colors shrink-0',
                  settingsStore.autoSync ? 'bg-blue-600' : 'bg-gray-300 dark:bg-neutral-700'
                ]"
              >
                <span
                  :class="[
                    'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
                    settingsStore.autoSync ? 'translate-x-5' : ''
                  ]"
                />
              </button>
            </div>

            <div
              class="mt-3 text-sm"
              :class="
                lastSyncState
                  ? lastSyncState.success
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                  : 'text-gray-500 dark:text-neutral-400'
              "
            >
              上次同步：{{ syncStatusText }}
            </div>
          </div>

          <div class="flex flex-wrap gap-3">
            <button
              @click="handleTestCloudConnection"
              :disabled="cloudTesting || !isLoggedIn"
              class="px-4 py-2 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ cloudTesting ? '测试中...' : '测试连接' }}
            </button>
            <button
              @click="handleSync"
              :disabled="cloudSyncing || !isLoggedIn"
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ cloudSyncing ? '同步中...' : '立即同步' }}
            </button>
            <button
              @click="handleSyncSettings"
              :disabled="settingsSyncing || !isLoggedIn"
              class="px-4 py-2 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ settingsSyncing ? '同步中...' : '同步设置' }}
            </button>
          </div>

          <div
            v-if="settingsSyncResult"
            :class="[
              'p-3 rounded-md text-sm',
              settingsSyncResult.success ? 'bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400' : 'bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400'
            ]"
          >
            {{ settingsSyncResult.message }}
          </div>

          <div
            v-if="cloudResult"
            :class="[
              'p-3 rounded-md text-sm',
              cloudResult.success ? 'bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400' : 'bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400'
            ]"
          >
            {{ cloudResult.message }}
          </div>
        </div>
      </div>

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <button
          @click="showDevOptions = !showDevOptions"
          class="flex items-center justify-between w-full"
        >
          <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100">开发者选项</h2>
          <svg
            :class="['w-5 h-5 text-gray-500 dark:text-neutral-400 transition-transform', showDevOptions ? 'rotate-180' : '']"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div v-if="showDevOptions" class="mt-4 space-y-4">
          <div>
            <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">数据管理</h3>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mb-3">
              所有数据存储在浏览器本地，清除浏览器数据会丢失。建议定期备份。
            </p>
            <div class="flex flex-wrap gap-3">
              <button
                @click="exportAllData"
                :disabled="exporting"
                class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {{ exporting ? '导出中...' : '导出所有数据' }}
              </button>
              <label class="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 cursor-pointer">
                {{ importing ? '导入中...' : '导入所有数据' }}
                <input type="file" accept=".json" @change="importAllData" class="hidden" :disabled="importing" />
              </label>
            </div>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-3">
              导出包含：所有文章、单词、标记、AI设置。导入会自动合并，相同文章和单词会被跳过。
            </p>
          </div>

          <div v-if="dataStats" class="bg-gray-50 dark:bg-neutral-800 rounded-lg p-4">
            <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">数据统计</h3>
            <div class="grid grid-cols-2 gap-2 text-sm">
              <div class="text-gray-600 dark:text-neutral-400">文章数量：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ dataStats.articles }}</span></div>
              <div class="text-gray-600 dark:text-neutral-400">单词数量：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ dataStats.words }}</span></div>
              <div class="text-gray-600 dark:text-neutral-400">标记记录：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ dataStats.wordMarks }}</span></div>
              <div class="text-gray-600 dark:text-neutral-400">翻译记录：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ dataStats.contextTranslations }}</span></div>
            </div>
            <button
              @click="loadStats"
              class="mt-2 px-3 py-1 text-xs bg-gray-200 dark:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded hover:bg-gray-300 dark:hover:bg-neutral-600"
            >
              刷新统计
            </button>
          </div>

          <div class="border-t border-gray-200 dark:border-neutral-800 pt-4">
            <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">性能限制</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">最大并发数</label>
                <input
                  v-model.number="settingsStore.maxConcurrency"
                  type="number"
                  min="1"
                  max="100"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  批量生成单词时同时发起的请求数上限
                </p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">请求超时（秒）</label>
                <input
                  v-model.number="settingsStore.requestTimeout"
                  type="number"
                  min="1"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  单次AI请求的超时时间，超时自动中止
                </p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">单词信息 max_tokens</label>
                <input
                  v-model.number="settingsStore.basicInfoMaxTokens"
                  type="number"
                  min="1"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  单词音标与释义请求允许生成的最大 token 数
                </p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">上下文翻译 max_tokens</label>
                <input
                  v-model.number="settingsStore.contextMaxTokens"
                  type="number"
                  min="1"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  上下文翻译请求允许生成的最大 token 数
                </p>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章生成 max_tokens</label>
                <input
                  v-model.number="settingsStore.articleMaxTokens"
                  type="number"
                  min="1"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  文章生成请求允许生成的最大 token 数
                </p>
              </div>
            </div>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-3">
              修改后自动保存，立即生效
            </p>
          </div>

          <div class="border-t border-gray-200 dark:border-neutral-800 pt-4">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300">调试模式</h3>
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  开启后，每次同步（手动或自动）都会在浏览器控制台（F12 → Console）输出同步时间、触发来源、耗时、各表推送/新增/更新/删除数量以及云端/本地记录数，便于排查同步问题。
                </p>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settingsStore.debugMode"
                @click="settingsStore.debugMode = !settingsStore.debugMode"
                :class="[
                  'relative w-11 h-6 rounded-full transition-colors shrink-0',
                  settingsStore.debugMode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-neutral-700'
                ]"
              >
                <span
                  :class="[
                    'absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
                    settingsStore.debugMode ? 'translate-x-5' : ''
                  ]"
                />
              </button>
            </div>
          </div>

          <div class="border-t border-gray-200 dark:border-neutral-800 pt-4">
            <h3 class="text-sm font-medium text-red-700 dark:text-red-400 mb-2">危险操作</h3>
            <button
              @click="handleClearCloud"
              :disabled="cloudClearing || !isLoggedIn"
              class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ cloudClearing ? '清除中...' : '清除云端数据' }}
            </button>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-2">
              删除该用户名在云端的所有数据（文章、单词、标记、翻译），不影响本地数据，此操作不可恢复
            </p>
            <div
              v-if="devCloudResult"
              :class="[
                'mt-3 p-3 rounded-md text-sm',
                devCloudResult.success ? 'bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400' : 'bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400'
              ]"
            >
              {{ devCloudResult.message }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- AI 配置弹窗 -->
    <AIConfigModal :open="aiConfigOpen" @close="aiConfigOpen = false" />
  </div>
</template>
