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
          <div class="hidden md:flex items-center space-x-4">
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
          <div class="md:hidden flex items-center">
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

    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-24 md:pb-8">
      <RouterView />
    </main>

    <nav
      class="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-neutral-800 pb-[env(safe-area-inset-bottom)]"
    >
      <div class="flex h-14">
        <RouterLink
          to="/"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-medium text-gray-500 dark:text-neutral-400"
          active-class="text-blue-600 dark:text-blue-400"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1h3a1 1 0 001-1V10" />
          </svg>
          首页
        </RouterLink>
        <RouterLink
          to="/vocabulary"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-medium text-gray-500 dark:text-neutral-400"
          active-class="text-blue-600 dark:text-blue-400"
        >
          <span class="relative">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span
              v-if="wordStore.markedCount > 0"
              class="absolute -top-1.5 -right-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 dark:bg-neutral-800 text-blue-800 dark:text-neutral-300"
            >
              {{ wordStore.markedCount > 99 ? '99+' : wordStore.markedCount }}
            </span>
          </span>
          词库
        </RouterLink>
        <RouterLink
          to="/settings"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-medium text-gray-500 dark:text-neutral-400"
          active-class="text-blue-600 dark:text-blue-400"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          设置
        </RouterLink>
      </div>
    </nav>
  </div>
</template>
