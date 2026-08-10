<script setup>
import { RouterView, useRouter, useRoute } from 'vue-router'
import { computed, onMounted, onUnmounted } from 'vue'
import { useWordStore } from './stores/word'
import { useAuthStore } from './stores/auth'
import AppHeader from './components/Common/AppHeader.vue'
import MobileTabBar from './components/Common/MobileTabBar.vue'
import { startAutoSync, stopAutoSync, requestSync } from './services/autoSync'

const wordStore = useWordStore()
const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

// 登录/注册页使用裸布局（无顶栏/底栏）
const isBare = computed(() => !!route.meta.bare)
// 阅读/学习页在移动端隐藏底部导航，避免遮挡内容
const hideMobileTab = computed(() => !!route.meta.hideMobileTab)

let unregisterRouteSync = null

onMounted(() => {
  wordStore.fetchMarkedWords()
  // 恢复登录会话
  auth.restoreSession()
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
    <AppHeader v-if="!isBare" />
    <main
      :class="[
        'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8',
        hideMobileTab ? 'pb-8' : 'pb-24 md:pb-8'
      ]"
    >
      <RouterView />
    </main>
    <MobileTabBar v-if="!isBare && !hideMobileTab" />
  </div>
</template>
