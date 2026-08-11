<script setup>
import { RouterView, useRouter, useRoute } from 'vue-router'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useWordStore } from './stores/word'
import { useAuthStore } from './stores/auth'
import { useSettingsStore } from './stores/settings'
import AppHeader from './components/Common/AppHeader.vue'
import MobileTabBar from './components/Common/MobileTabBar.vue'
import { startAutoSync, stopAutoSync, requestSync } from './services/autoSync'

const wordStore = useWordStore()
const auth = useAuthStore()
// 同步实例化 settings store：其 loadSettings 内部会立即 applyTheme / applyFontSize，
// 让字号与主题在 App 挂载前就写入 document.documentElement，避免首屏闪烁
const settingsStore = useSettingsStore()
const router = useRouter()
const route = useRoute()

// 登录/注册页使用裸布局（无顶栏/底栏）
const isBare = computed(() => !!route.meta.bare)

// 注意：main 不能加 overflow-hidden。翻页过渡期间容器高度由旧页撑起，
// 若新页内容更高，超出部分会被裁剪，出现"翻完才补出下半截"的现象。
// 横向溢出由 body 的 overflow-x: hidden 兜底。
// 阅读/学习页在移动端隐藏底部导航，避免遮挡内容
const hideMobileTab = computed(() => !!route.meta.hideMobileTab)

// ===== 页面切换过渡方向计算 =====
// 根据前后路由的 depth 元信息决定滑动方向：
// - 目标 depth 更大（进入更深层）→ slide-left（新页从右滑入，旧页向左推出）
// - 目标 depth 更小（返回更浅层）→ slide-right（新页从左滑入，旧页向右推出）
// - bare 布局页面（登录/注册/邮箱验证）或无 depth 信息 → 淡入淡出，不滑动
const transitionName = ref('fade')

let unregisterRouteSync = null
let unregisterBeforeEach = null
let preloadTimer = null

// 常用页面是懒加载分块，提前预热，避免首次切换时下载 chunk 造成卡顿/闪空。
// 首屏渲染完成后尽快预热（300ms），覆盖用户快速跳转的场景。
function preloadCommonPages() {
  preloadTimer = setTimeout(() => {
    import('./views/Vocabulary.vue').catch(() => {})
    import('./views/Settings.vue').catch(() => {})
    import('./views/Reader.vue').catch(() => {})
    import('./views/NewArticle.vue').catch(() => {})
    import('./views/GenerateArticle.vue').catch(() => {})
  }, 300)
}

/**
 * 预加载目标路由的异步组件（触发对应 chunk 下载并缓存）。
 * 返回 Promise，在导航继续前等待所有组件就绪，确保页面切换过渡动画
 * 播放时新页已有实际内容，而不是空白占位。
 * 组件加载失败时静默忽略，避免阻塞导航。
 */
function preloadRouteComponents(to) {
  return Promise.all(
    to.matched.map((record) => {
      const comp = record.components?.default
      if (typeof comp !== 'function') return Promise.resolve()
      return Promise.resolve(comp()).catch(() => {})
    })
  )
}

onMounted(() => {
  preloadCommonPages()
  wordStore.fetchMarkedWords()
  // 恢复登录会话
  auth.restoreSession()
  // 打开网站时启动后台自动云同步（首次同步会在渲染完成后延迟执行）
  startAutoSync()
  // 切换页面（路由）时触发一次后台同步，保证数据及时上传/拉取
  unregisterRouteSync = router.afterEach(() => requestSync())
  // 在路由进入前计算过渡方向，保证 Transition 组件拿到正确的 name
  unregisterBeforeEach = router.beforeEach(async (to, from) => {
    const toBare = !!to.meta?.bare
    const fromBare = !!from?.meta?.bare
    // 任一端是 bare 布局（登录/注册等）时使用淡入淡出，避免键盘弹起时的位移错乱
    if (toBare || fromBare) {
      transitionName.value = 'fade'
      await preloadRouteComponents(to)
      return
    }
    const toDepth = Number(to.meta?.depth ?? 0)
    const fromDepth = Number(from?.meta?.depth ?? 0)
    // depth 不同时按层级判断：进入更深层 → 左滑（前进），返回更浅层 → 右滑（返回）
    if (toDepth !== fromDepth) {
      transitionName.value = toDepth > fromDepth ? 'slide-left' : 'slide-right'
    } else {
      // depth 相等（同级页面，如词库↔设置）时按 order 判断视觉顺序
      const toOrder = Number(to.meta?.order ?? 0)
      const fromOrder = Number(from?.meta?.order ?? 0)
      transitionName.value = toOrder > fromOrder ? 'slide-left' : 'slide-right'
    }
    // 等待目标路由的异步组件加载完成再切换：避免 Transition 播放期间新页为空，
    // 表现为"滑动动画滑入一个空白页、内容才突然出现"的闪烁
    await preloadRouteComponents(to)
  })
})

onUnmounted(() => {
  if (preloadTimer) clearTimeout(preloadTimer)
  if (unregisterRouteSync) unregisterRouteSync()
  if (unregisterBeforeEach) unregisterBeforeEach()
  stopAutoSync()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-neutral-950">
    <AppHeader v-if="!isBare" />
    <main
      :class="[
        'mx-auto px-4 sm:px-6 lg:px-8 py-8 w-[min(95vw,1600px)]',
        hideMobileTab ? 'pb-8' : 'pb-24 md:pb-8'
      ]"
    >
      <div class="relative">
        <RouterView v-slot="{ Component }">
          <Transition :name="transitionName">
            <component :is="Component" :key="route.path" />
          </Transition>
        </RouterView>
      </div>
    </main>
    <MobileTabBar v-if="!isBare && !hideMobileTab" />
  </div>
</template>
