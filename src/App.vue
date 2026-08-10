<script setup>
import { RouterView, useRouter } from 'vue-router'
import { useWordStore } from './stores/word'
import AppHeader from './components/Common/AppHeader.vue'
import MobileTabBar from './components/Common/MobileTabBar.vue'
import { onMounted, onUnmounted } from 'vue'
import { startAutoSync, stopAutoSync, requestSync } from './services/autoSync'

const wordStore = useWordStore()
const router = useRouter()

let unregisterRouteSync = null

onMounted(() => {
  wordStore.fetchMarkedWords()
  // 打开网站时启动后台自动云同步（首次同步会在渲染完成后延迟执行）
  startAutoSync()
  // 切换页面（路由）时触发一次后台同步，保证数据及时上传/拉取
  unregisterRouteSync = router.afterEach(() => requestSync())
})

onUnmounted(() => {
  if (unregisterRouteSync) unregisterRouteSync()
  stopAutoSync()
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
  