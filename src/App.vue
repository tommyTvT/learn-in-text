<script setup>
import { RouterView } from 'vue-router'
import { useWordStore } from './stores/word'
import AppHeader from './components/Common/AppHeader.vue'
import MobileTabBar from './components/Common/MobileTabBar.vue'
import { onMounted } from 'vue'

const wordStore = useWordStore()

onMounted(() => {
  wordStore.fetchMarkedWords()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-neutral-950">
    <AppHeader />
    <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-24 md:pb-8">
      <RouterView />
    </main>
    <MobileTabBar />
  </div>
</template>
  