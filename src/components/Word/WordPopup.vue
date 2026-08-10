<script setup>
import { computed, ref, onMounted, onUnmounted, watch, nextTick } from 'vue'

const props = defineProps({
  word: String,
  wordInfo: Object,
  position: Object,
  loading: Boolean,
  loadingContext: Boolean,
  contextTranslation: String,
  contextError: Boolean,
  articleId: Number,
  isMarked: Boolean
})

const emit = defineEmits(['close', 'auto-generate', 'retry-context'])

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
const entering = ref(true)   // 进入动画：从下方滑入
const closing = ref(false)   // 收起动画：向下滑出

// PC 端定位稳定性：
// 锁定弹窗相对单词的垂直方向（'below' | 'above'），内容动态加载导致高度变化时不翻转方向
let popupSide = null
// 内容尺寸变化后，在下一帧重新测量并定位，避免中间态跳变
let resizeRaf = null
let resizeObserver = null

// PC 端内容高度过渡：把内部内容实际高度同步到外层 wrapper，使高度变化平滑
const contentHeightWrapRef = ref(null)
const contentInnerRef = ref(null)
let contentHeightObserver = null

const handleMqChange = (e) => {
  isMobile.value = e.matches
  if (!e.matches) {
    nextTick(() => adjustPosition())
  }
}

const definitions = computed(() => props.wordInfo?.definitions?.slice(0, 2) || [])

const contextTranslation = computed(() => {
  const raw = props.contextTranslation
  if (!raw) return null
  const parts = []
  const regex = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match
  while ((match = regex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: raw.slice(lastIndex, match.index), highlight: false })
    }
    parts.push({ text: match[1], highlight: true })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < raw.length) {
    parts.push({ text: raw.slice(lastIndex), highlight: false })
  }
  if (parts.length === 0 && raw) {
    parts.push({ text: raw, highlight: false })
  }
  return parts.length > 0 ? parts : null
})

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
  // PC 端：监听弹窗尺寸变化（内容动态加载会改变高度），稳定后重定位，避免跳变
  if (typeof ResizeObserver !== 'undefined' && popupRef.value) {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(popupRef.value)
  }
  // PC 端：把内部内容实际高度同步到外层 wrapper，使"在文中"等内容加载引起的高度变化平滑过渡
  if (!isMobile.value && typeof ResizeObserver !== 'undefined' && contentInnerRef.value && contentHeightWrapRef.value) {
    contentHeightObserver = new ResizeObserver(() => syncContentHeight())
    contentHeightObserver.observe(contentInnerRef.value)
    contentHeightObserver.observe(contentHeightWrapRef.value)
    syncContentHeight()
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

// PC 端：同步内容高度到外层 wrapper（高度变化通过 CSS transition 平滑过渡）
function syncContentHeight() {
  if (!contentInnerRef.value || !contentHeightWrapRef.value) return
  const h = contentInnerRef.value.getBoundingClientRect().height
  contentHeightWrapRef.value.style.height = `${h}px`
}

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
  if (contentHeightObserver) {
    contentHeightObserver.disconnect()
    contentHeightObserver = null
  }
  if (resizeRaf) {
    cancelAnimationFrame(resizeRaf)
    resizeRaf = null
  }
})

watch(() => [props.loading, props.wordInfo, props.loadingContext], () => {
  // 内容动态加载：先同步高度触发过渡，待高度过渡结束后再用最终尺寸重新定位，避免用中间高度
  if (isMobile.value) return
  nextTick(() => {
    syncContentHeight()
    setTimeout(handleResize, 220)
  })
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
  const wordRect = props.position?.wordRect
  if (!wordRect) return

  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 8
  const pad = 16

  const popupWidth = popupRect.width
  const popupHeight = popupRect.height

  // 水平居中：相对于单词中心，并钳制在视口内
  let left = wordRect.left + wordRect.width / 2 - popupWidth / 2
  left = Math.max(pad, Math.min(left, vw - popupWidth - pad))

  // 垂直方向：首次定位时决定方向并锁定。方向用"固定高度预估"判定（不依赖加载中的临时高度），
  // 因此内容动态加载导致弹窗高度变化时方向始终保持不变，杜绝上下翻转跳变。
  if (popupSide === null) {
    // 预估弹窗最终高度（一般不会超过视口 45%，且有 max-h 兜底）
    const estHeight = Math.min(vh * 0.45, 420)
    const belowRoom = vh - wordRect.bottom - gap
    const aboveRoom = wordRect.top - gap
    if (belowRoom >= estHeight) popupSide = 'below'
    else if (aboveRoom >= estHeight) popupSide = 'above'
    else popupSide = belowRoom >= aboveRoom ? 'below' : 'above'
  }

  // 按锁定方向计算 top，仅在同侧调整，绝不因高度变化翻转
  let top
  if (popupSide === 'below') {
    top = wordRect.bottom + gap
  } else {
    top = wordRect.top - popupHeight - gap
  }

  // 最终边界钳制，保证弹窗不超出视口
  top = Math.max(pad, Math.min(top, vh - popupHeight - pad))

  // 更新样式（一步到位，无闪烁）
  popupStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    opacity: 1
  }
}

// 内容尺寸变化（如"在文中"上下文翻译加载完成）后稳定重定位
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
          'bottom-0 inset-x-0 rounded-t-2xl border-t border-gray-200 dark:border-neutral-800 min-h-[33vh] max-h-[92vh] overflow-y-auto shadow-[0_-8px_30px_rgba(0,0,0,0.15)]',
          'transition-transform duration-300 ease-out',
          entering || closing ? 'translate-y-full' : 'translate-y-0'
        ]
      : 'rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 w-64 max-h-[75vh] overflow-y-auto transition-[left,top,opacity] duration-150'"
    :style="isMobile ? {} : popupStyle"
  >
    <div class="flex justify-center pt-2 sm:hidden">
      <div class="w-10 h-1 rounded-full bg-gray-300 dark:bg-neutral-700"></div>
    </div>
    <div ref="contentHeightWrapRef" class="overflow-hidden transition-[height] duration-200 ease-out">
    <div ref="contentInnerRef" class="p-4 pb-8 sm:p-3 sm:pb-3">
      <div class="flex items-start gap-2 mb-2">
        <div class="flex items-baseline gap-2 flex-1 min-w-0">
          <span class="text-xl sm:text-lg font-bold text-gray-900 dark:text-neutral-100">{{ word }}</span>
          <span v-if="wordInfo?.phonetic" class="text-sm text-gray-500 dark:text-neutral-400">
            {{ wordInfo.phonetic }}
          </span>
        </div>
        <span
          v-if="isMarked"
          class="flex-shrink-0 px-2 py-0.5 text-xs font-medium bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 rounded-full"
        >
          已标记
        </span>
        <button
          @click="startClose"
          class="flex-shrink-0 p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200"
          aria-label="关闭"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div v-if="loading" class="py-3 text-center">
        <div class="animate-spin inline-block w-5 h-5 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
      </div>

      <template v-else>
        <div v-if="definitions.length > 0">
          <div v-for="(def, i) in definitions" :key="i" class="text-base sm:text-sm">
            <span v-if="def.partOfSpeech" class="text-blue-600 dark:text-blue-400 font-medium">{{ def.partOfSpeech }}</span>
            <span class="text-gray-700 dark:text-neutral-300 ml-1">{{ def.meaning }}</span>
          </div>
        </div>

        <div v-if="loadingContext || contextTranslation || contextError" class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
          <div class="text-sm sm:text-xs text-gray-500 dark:text-neutral-400 mb-1">在文中</div>
          <div v-if="loadingContext" class="py-2">
            <div class="animate-spin inline-block w-4 h-4 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
          </div>
          <div v-else-if="contextTranslation" class="text-base sm:text-sm text-gray-700 dark:text-neutral-300">
            <template v-for="(part, i) in contextTranslation" :key="i">
              <span v-if="part.highlight" class="text-blue-600 dark:text-blue-400 font-medium">{{ part.text }}</span>
              <span v-else>{{ part.text }}</span>
            </template>
          </div>
          <div v-else-if="contextError" class="flex items-center gap-2 py-1">
            <span class="text-xs text-red-500 dark:text-red-400">翻译失败</span>
            <button
              @click="$emit('retry-context')"
              class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
            >重试</button>
          </div>
        </div>

        <div v-if="!definitions.length && !loading && wordInfo" class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
          <button
            @click="$emit('auto-generate', word)"
            class="w-full text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 py-1"
          >
            点击生成详细释义
          </button>
        </div>
      </template>
    </div>
    </div>
  </div>
</template>
