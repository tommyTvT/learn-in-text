<script setup>
import { RouterLink } from 'vue-router'
import { useWordStore } from '../../stores/word'

const wordStore = useWordStore()

const tabItems = [
  {
    to: '/',
    label: '首页',
    paths: ['M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1h3a1 1 0 001-1V10'],
  },
  {
    to: '/vocabulary',
    label: '词库',
    badge: true,
    paths: ['M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253'],
  },
  {
    to: '/settings',
    label: '设置',
    paths: [
      'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
      'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    ],
  },
]

</script>

<template>
  <nav
    class="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-neutral-900 border-t border-gray-200 dark:border-neutral-800 pb-[env(safe-area-inset-bottom)]"
  >
    <div class="flex h-14">
      <RouterLink
        v-for="item in tabItems"
        :key="item.to"
        :to="item.to"
        class="flex-1 flex flex-col items-center justify-center gap-0.5 text-xs font-medium text-gray-500 dark:text-neutral-400"
        active-class="text-blue-600 dark:text-blue-400"
      >
        <span class="relative">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              v-for="(d, i) in item.paths"
              :key="i"
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              :d="d"
            />
          </svg>
          <span
            v-if="item.badge && wordStore.markedCount > 0"
            class="absolute -top-1.5 -right-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 dark:bg-neutral-800 text-blue-800 dark:text-neutral-300"
          >
            {{ wordStore.markedCount > 99 ? '99+' : wordStore.markedCount }}
          </span>
        </span>
        {{ item.label }}
      </RouterLink>
    </div>
  </nav>
</template>
