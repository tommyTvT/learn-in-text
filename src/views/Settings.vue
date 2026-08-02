<script setup>
import { ref, onMounted } from 'vue'
import { useSettingsStore, AI_PROVIDERS } from '../stores/settings'
import { testConnection } from '../services/ai'
import { exportService } from '../services/db'

const settingsStore = useSettingsStore()

const showApiKey = ref(false)
const testing = ref(false)
const testResult = ref(null)
const exporting = ref(false)
const importing = ref(false)
const showDevOptions = ref(false)
const dataStats = ref(null)

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

function saveAndClose() {
  settingsStore.saveSettings()
  alert('设置已保存')
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

async function clearAllData() {
  if (!confirm('⚠️ 此操作将删除所有数据（文章、单词、标记），且不可恢复。\n\n确定要清除所有数据吗？')) return
  if (!confirm('再次确认：真的要删除所有数据吗？')) return

  try {
    await exportService.clearAllData()
    localStorage.clear()
    alert('所有数据已清除，页面将刷新')
    window.location.reload()
  } catch (error) {
    alert('清除失败: ' + error.message)
  }
}

async function resetDatabase() {
  if (!confirm('⚠️ 此操作将删除整个数据库并重建，所有数据将丢失。\n\n确定要重置数据库吗？')) return
  if (!confirm('再次确认：真的要重置数据库吗？')) return

  try {
    await exportService.deleteDatabase()
    localStorage.clear()
    alert('数据库已重置，页面将刷新')
    window.location.reload()
  } catch (error) {
    alert('重置失败: ' + error.message)
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

    <div class="max-w-2xl">
      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6 mb-6">
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

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6 mb-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">AI 接口配置</h2>
        <p class="text-sm text-gray-600 dark:text-neutral-400 mb-4">
          配置OpenAI兼容的API接口，用于生成单词信息和文章
        </p>

        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">AI 厂商</label>
            <select
              v-model="settingsStore.aiProvider"
              @change="settingsStore.applyProvider(settingsStore.aiProvider)"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option v-for="(provider, key) in AI_PROVIDERS" :key="key" :value="key">
                {{ provider.name }}（{{ provider.model }}）
              </option>
              <option value="custom">自定义</option>
            </select>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
              选择预设厂商后只需填写 API Key，接口地址和模型已自动配置
            </p>
          </div>

          <div v-if="settingsStore.isPreset" class="bg-gray-50 dark:bg-neutral-800 rounded-md p-3 text-sm text-gray-600 dark:text-neutral-400">
            <div class="mb-1">接口地址：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ settingsStore.aiEndpoint }}</span></div>
            <div>模型：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ settingsStore.aiModel }}</span></div>
          </div>

          <div v-if="!settingsStore.isPreset">
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">API 端点</label>
            <input
              v-model="settingsStore.aiEndpoint"
              type="text"
              placeholder="https://api.openai.com/v1"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            />
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
              OpenAI兼容接口地址，例如：https://api.openai.com/v1
            </p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">API Key</label>
            <div class="relative">
              <input
                v-model="settingsStore.aiApiKey"
                :type="showApiKey ? 'text' : 'password'"
                placeholder="sk-..."
                class="w-full px-3 py-2 pr-20 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
              />
              <button
                @click="showApiKey = !showApiKey"
                class="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-sm text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200"
              >
                {{ showApiKey ? '隐藏' : '显示' }}
              </button>
            </div>
          </div>

          <div v-if="!settingsStore.isPreset">
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">模型</label>
            <input
              v-model="settingsStore.aiModel"
              type="text"
              placeholder="gpt-3.5-turbo"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            />
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
              例如：gpt-3.5-turbo, gpt-4, claude-3-sonnet 等
            </p>
          </div>

          <div class="flex items-center space-x-3">
            <button
              @click="handleTestConnection"
              :disabled="testing || !settingsStore.aiEndpoint || !settingsStore.aiApiKey"
              class="px-4 py-2 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ testing ? '测试中...' : '测试连接' }}
            </button>
            <button
              @click="saveAndClose"
              class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              保存设置
            </button>
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
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">数据管理</h2>
        <p class="text-sm text-gray-600 dark:text-neutral-400 mb-4">
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

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6 mt-6">
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
            <h3 class="text-sm font-medium text-red-700 dark:text-red-400 mb-2">危险操作</h3>
            <div class="flex flex-wrap gap-3">
              <button
                @click="clearAllData"
                class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                清除所有数据
              </button>
              <button
                @click="resetDatabase"
                class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700"
              >
                重置数据库
              </button>
            </div>
            <p class="text-xs text-gray-500 dark:text-neutral-400 mt-2">
              清除所有数据：删除 IndexedDB 所有表内容和 localStorage 设置<br>
              重置数据库：删除整个 IndexedDB 数据库并重建（用于修复 schema 不一致问题）
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
