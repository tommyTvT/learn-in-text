<script setup>
import { RouterView, RouterLink } from 'vue-router'
import { useWordStore } from './stores/word'
import { useSettingsStore } from './stores/settings'
import { onMounted } from 'vue'

const wordStore = useWordStore()
const settingsStore = useSettingsStore()

onMounted(() => {
  wordStore.fetchMarkedWords()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-neutral-950">
    <nav class="bg-white dark:bg-neutral-900 shadow-sm border-b border-gray-200 dark:border-neutral-800">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center">
            <RouterLink to="/" class="flex items-center space-x-2">
              <span class="text-2xl">📚</span>
              <span class="text-xl font-bold text-gray-900 dark:text-neutral-100">Learn in Text</span>
            </RouterLink>
          </div>
          <div class="flex items-center space-x-4">
            <RouterLink
              to="/"
              class="px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
              active-class="bg-blue-50 dark:bg-neutral-800 text-blue-700 dark:text-neutral-100"
            >
              首页
            </RouterLink>
            <RouterLink
              to="/vocabulary"
              class="px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
              active-class="bg-blue-50 dark:bg-neutral-800 text-blue-700 dark:text-neutral-100"
            >
              词库
              <span
                v-if="wordStore.markedCount > 0"
                class="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-neutral-800 text-blue-800 dark:text-neutral-300"
              >
                {{ wordStore.markedCount }}
              </span>
            </RouterLink>
            <RouterLink
              to="/settings"
              class="px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
              active-class="bg-blue-50 dark:bg-neutral-800 text-blue-700 dark:text-neutral-100"
            >
              设置
            </RouterLink>
            <button
              @click="settingsStore.toggleTheme"
              class="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-gray-700 dark:hover:text-neutral-200"
              :title="settingsStore.isDark ? '切换到浅色模式' : '切换到深色模式'"
            >
              <svg v-if="settingsStore.isDark" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </nav>

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <RouterView />
    </main>
  </div>
</template>
