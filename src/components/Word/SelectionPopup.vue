<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { MessageCircleQuestion } from 'lucide-vue-next'

const props = defineProps({
  text: String,
  translation: String,
  loading: Boolean,
  error: Boolean,
  // 选区矩形快照 { left, top, right, bottom, width, height }，可为 null（部分移动端取不到）
  position: Object
})

const emit = defineEmits(['close', 'retry', 'ask'])

const popupRef = ref(null)
const popupStyle = ref({
  left: '-9999px',
  top: '-9999px',
  opacity: 0
})

const isMobile = ref(false)
let mq = null
let lastTouchCloseTime = 0

// 移动端底部弹出/收起动画状态
const entering = ref(true)
const closing = ref(false)

// PC 端定位稳定性：锁定弹窗相对选区的垂直方向（'below' | 'above'），译文加载导致高度变化时不翻转
let popupSide = null
let resizeRaf = null
let resizeObserver = null

// 原文超长时折叠，点击展开/收起
const expanded = ref(false)
const isLongText = computed(() => (props.text || '').length > 160)

const handleMqChange = (e) => {
  isMobile.value = e.matches
  if (!e.matches) {
    nextTick(() => adjustPosition())
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('touchstart', handleClickOutside, { passive: true })
  mq = window.matchMedia('(max-width: 639px)')
  isMobile.value = mq.matches
  if (mq.addEventListener) {
    mq.addEventListener('change', handleMqChange)
  } else {
    mq.addListener(handleMqChange)
  }
  // PC 端：译文加载完成后高度变化，稳定后重定位（方向已锁定，不会翻转跳变）
  if (typeof ResizeObserver !== 'undefined' && popupRef.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(popupRef.value)
  }
  nextTick(() => {
    if (!isMobile.value) {
      adjustPosition()
    }
    popupStyle.value.opacity = 1
    // 移动端：触发从下方滑入动画
    if (isMobile.value) {
      requestAnimationFrame(() => {
        entering.value = false
      })
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('touchstart', handleClickOutside)
  if (mq) {
    if (mq.removeEventListener) {
      mq.removeEventListener('change', handleMqChange)
    } else {
      mq.removeListener(handleMqChange)
    }
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = null
  }
})

watch(() => [props.loading, props.translation], () => {
  if (isMobile.value) return
  nextTick(() => adjustPosition())
})

function handleClickOutside(event) {
  if (popupRef.value && !popupRef.value.contains(event.target)) {
    const now = Date.now()
    if (event.type === 'touchstart') {
      lastTouchCloseTime = now
    } else if (now - lastTouchCloseTime < 500) {
      return
    }
    startClose()
  }
}

// 移动端：先播放向下滑出动画，动画结束后再通知父组件卸载
function startClose() {
  if (closing.value) return
  if (!isMobile.value) {
    emit('close')
    return
  }
  closing.value = true
  setTimeout(() => {
    emit('close')
  }, 250)
}

function adjustPosition() {
  if (!popupRef.value) return

  const popupRect = popupRef.value.getBoundingClientRect()
  const rect = props.position
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 8
  const pad = 16

  // 锚点：选区矩形；取不到时退化为视口中心
  const anchorLeft = rect ? rect.left + rect.width / 2 : vw / 2
  const anchorTop = rect ? rect.top : vh / 2
  const anchorBottom = rect ? rect.bottom : vh / 2

  // 水平居中于选区中心，并钳制在视口内
  let left = anchorLeft - popupRect.width / 2
  left = Math.max(pad, Math.min(left, vw - popupRect.width - pad))

  // 垂直方向：首次定位时决定方向并锁定（用固定高度预估判定，不依赖加载中的临时高度）
  if (popupSide === null) {
    const estHeight = Math.min(vh * 0.4, 320)
    const belowRoom = vh - anchorBottom - gap
    const aboveRoom = anchorTop - gap
    if (belowRoom >= estHeight) popupSide = 'below'
    else if (aboveRoom >= estHeight) popupSide = 'above'
    else popupSide = belowRoom >= aboveRoom ? 'below' : 'above'
  }

  // 按锁定方向计算 top，仅在同侧调整，绝不因高度变化翻转
  let top
  if (popupSide === 'below') {
    top = anchorBottom + gap
  } else {
    top = anchorTop - popupRect.height - gap
  }
  top = Math.max(pad, Math.min(top, vh - popupRect.height - pad))

  popupStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    opacity: 1
  }
}

function handleResize() {
  if (isMobile.value) return
  if (resizeRaf) cancelAnimationFrame(resizeRaf)
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null
    adjustPosition()
  })
}
</script>

<template>
  <div
    ref="popupRef"
    class="fixed z-50 bg-white dark:bg-neutral-900 transition-opacity duration-150"
    :class="isMobile
      ? [
          'bottom-0 inset-x-0 rounded-t-2xl border-t border-gray-200 dark:border-neutral-800 min-h-[20vh] max-h-[60vh] overflow-y-auto shadow-[0_-8px_30px_rgba(0,0,0,0.15)]',
          'transition-transform duration-300 ease-out',
          entering || closing ? 'translate-y-full' : 'translate-y-0'
        ]
      : 'rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 w-80 max-h-[60vh] overflow-y-auto transition-[left,top,opacity] duration-150'"
    :style="isMobile ? {} : popupStyle"
  >
    <div class="flex justify-center pt-2 sm:hidden">
      <div class="w-10 h-1 rounded-full bg-gray-300 dark:bg-neutral-700"></div>
    </div>
    <div class="p-4 pb-8 sm:p-3 sm:pb-3">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-medium text-gray-500 dark:text-neutral-400">原文</span>
        <button
          @click="startClose"
          class="p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200"
          aria-label="关闭"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <p
        class="text-sm text-gray-800 dark:text-neutral-200 whitespace-pre-wrap break-words"
        :class="{ 'line-clamp-3': !expanded }"
      >{{ text }}</p>
      <button
        v-if="isLongText"
        @click="expanded = !expanded"
        class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 mt-1"
      >{{ expanded ? '收起' : '展开' }}</button>

      <div class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
        <div class="text-sm font-medium text-gray-500 dark:text-neutral-400 mb-1">译文</div>
        <div v-if="loading" class="py-3 text-center">
          <div class="animate-spin inline-block w-5 h-5 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
        </div>
        <div v-else-if="error" class="flex items-center gap-2 py-1">
          <span class="text-xs text-red-500 dark:text-red-400">翻译失败</span>
          <button
            @click="$emit('retry')"
            class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
          >重试</button>
        </div>
        <p
          v-else-if="translation"
          class="text-base sm:text-sm text-gray-700 dark:text-neutral-300 whitespace-pre-wrap break-words"
        >{{ translation }}</p>
      </div>

      <div class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
        <button
          @click="$emit('ask')"
          class="w-full flex items-center justify-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 py-1"
        >
          <MessageCircleQuestion class="w-4 h-4" />
          追问解析（语法、用法等）
        </button>
      </div>
    </div>
  </div>
</template>
