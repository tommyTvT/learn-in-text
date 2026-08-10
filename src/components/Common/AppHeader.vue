<script setup>
import { RouterLink } from 'vue-router'
import { useWordStore } from '../../stores/word'
import ThemeToggle from './ThemeToggle.vue'

const wordStore = useWordStore()

const navLinks = [
  { to: '/', label: '首页' },
  { to: '/vocabulary', label: '词库', badge: true },
  { to: '/settings', label: '设置' },
]
</script>

<template>
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
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="px-3 py-2 rounded-md text-sm font-medium text-gray-700 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-neutral-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
            active-class="bg-blue-50 dark:bg-neutral-800 text-blue-700 dark:text-neutral-100"
          >
            {{ link.label }}
            <span
              v-if="link.badge && wordStore.markedCount > 0"
              class="ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-neutral-800 text-blue-800 dark:text-neutral-300"
            >
              {{ wordStore.markedCount }}
            </span>
          </RouterLink>
          <ThemeToggle />
        </div>
        <div class="md:hidden flex items-center">
          <ThemeToggle />
        </div>
      </div>
    </div>
  </nav>
</template>
