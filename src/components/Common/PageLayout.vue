<script setup>
import { ref } from 'vue'
import { onShow } from '@dcloudio/uni-app'
import { requestSync } from '../../services/autoSync'
import AppHeader from './AppHeader.vue'
import MobileTabBar from './MobileTabBar.vue'

// 全局页面布局（承载原 App.vue 的模板结构）：
// - bare：裸布局（登录/注册/邮箱验证），不渲染任何导航
// - hideTab：隐藏底部 TabBar（阅读页用，避免遮挡内容）
defineProps({
  bare: { type: Boolean, default: false },
  hideTab: { type: Boolean, default: false },
})

// 入场动画开关：动画播完立即移除动画类。
// 关键原因：slide 动画的 transform 即使结束、即使 fill 的是单位矩阵
// （matrix(1,0,0,1,0,0)），也会给容器创建 containing block，
// 使页面内所有 position:fixed 的弹窗/气泡退化为"相对该容器定位"，
// 表现为滚动后弹窗漂移、模态居中到整个文档正中而非视口正中。
const animClass = ref('page-anim-slide')

function onAnimEnd() {
  animClass.value = ''
}

// 页面显示时触发一次后台同步（对应原 vue-router afterEach 触发 requestSync）
onShow(() => requestSync())
</script>

<template>
  <div class="min-h-screen bg-gray-50 dark:bg-neutral-950">
    <AppHeader v-if="!bare" />
    <main
      :class="[
        'mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-6 w-[min(95vw,1600px)]',
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
