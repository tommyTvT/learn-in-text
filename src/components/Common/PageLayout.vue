<script setup>
import { ref, watch } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { useRoute, useRouter, usePageRoute } from '../../composables/routerShim'
import { requestSync } from '../../services/autoSync'
import { getOwnershipPending, clearOwnershipPending } from '../../services/localData'
import { useAuthStore } from '../../stores/auth'
import AppHeader from './AppHeader.vue'
import MobileTabBar from './MobileTabBar.vue'

// 全局页面布局（承载原 App.vue 的模板结构）：
// - bare：裸布局（登录/注册/邮箱验证），不渲染任何导航
// - hideTab：隐藏底部 TabBar（阅读页用，避免遮挡内容）
defineProps({
  bare: { type: Boolean, default: false },
  hideTab: { type: Boolean, default: false },
})

const auth = useAuthStore()
usePageRoute()
const route = useRoute()
const router = useRouter()

// 入场动画开关：动画播完立即移除动画类。
// 关键原因：slide 动画的 transform 即使结束、即使 fill 的是单位矩阵
// （matrix(1,0,0,1,0,0)），也会给容器创建 containing block，
// 使页面内所有 position:fixed 的弹窗/气泡退化为"相对该容器定位"，
// 表现为滚动后弹窗漂移、模态居中到整个文档正中而非视口正中。
const animClass = ref('page-anim-slide')

function onAnimEnd() {
  animClass.value = ''
}

// 认证页路径：自带归属决策流程，本组件不再重复引导
const AUTH_PATHS = ['/login', '/register', '/email-verified']

/**
 * 上次登录的归属决策未完成（弹窗期间关闭/离开页面）时，
 * 把用户引导回登录页继续决策。后台自动同步已被 pending 标记
 * 持续拦截，这里只负责不让决策被遗忘，避免长期无同步。
 */
function resumePendingOwnershipDecision() {
  // 会话恢复完成前 username 可能还是空值，此时无法判断 pending 归属，
  // 等待 auth.ready（由下方 watch 在恢复完成时补查）
  if (!auth.ready) return
  if (!auth.isLoggedIn) return
  const pending = getOwnershipPending()
  if (!pending) return
  if (pending !== auth.username) {
    // 决策上下文已变化（如其他标签页换号登录）：旧标记失效，清除
    clearOwnershipPending()
    return
  }
  if (AUTH_PATHS.some((p) => route.path?.startsWith(p))) return
  router.replace('/login')
}

// 启动时 onShow 往往早于会话恢复完成（auth.ready=false），
// 恢复完成的瞬间补查一次，保证未完成的归属决策不会被遗漏
watch(() => auth.ready, (ready) => {
  if (ready) resumePendingOwnershipDecision()
})

// 页面显示时触发一次后台同步（对应原 vue-router afterEach 触发 requestSync）
onShow(() => {
  requestSync()
  resumePendingOwnershipDecision()
})
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-neutral-950">
    <AppHeader v-if="!bare" />
    <main
      :class="[
        // 移动端顶部只留极小的呼吸位（pt-3），消除顶栏与内容之间多余的大留白；
        // 桌面端保持原有 sm:py-6 的宽松间距。
        // 宽度：手机端铺满 100%，不再保留 95vw 的左右留白（窄屏这 5vw 很浪费，
        // 也会让「全宽列表 / 全宽正文」的负外边距够不到屏幕边缘）；
        // 桌面端仍限制最大宽度避免正文行宽过长。
        'mx-auto px-4 sm:px-6 lg:px-8 pt-3 sm:pt-6 w-full sm:w-[min(95vw,1600px)]',
        hideTab ? 'pb-6' : 'pb-20 md:pb-6'
      ]"
    >
      <!-- 入场动画挂在内容容器；fade 结束（或 fill 为 none）后 transform 不残留，
           slide 则必须靠 @animationend 摘类清除 containing block -->
      <div
        :class="[bare ? 'page-anim-fade' : animClass]"
        @animationend.self="onAnimEnd"
      >
        <slot />
      </div>
    </main>
    <MobileTabBar v-if="!bare && !hideTab" />
  </div>
</template>
