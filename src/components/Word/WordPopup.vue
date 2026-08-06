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
  nextTick(() => {
    if (!isMobile.value) {
      adjustPosition()
    }
    popupStyle.value.opacity = 1
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
})

watch(() => [props.loading, props.wordInfo, props.loadingContext], () => {
  nextTick(() => {
    if (!isMobile.value) {
      adjustPosition()
    }
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
    emit('close')
  }
}

function adjustPosition() {
  if (!popupRef.value) return

  const popupRect = popupRef.value.getBoundingClientRect()
  const wordRect = props.position.wordRect
  const vw = window.innerWidth
  const vh = window.innerHeight
  const gap = 8
  const pad = 16

  const popupWidth = popupRect.width
  const popupHeight = popupRect.height

  // 水平居中：相对于单词中心
  let left = wordRect.left + wordRect.width / 2 - popupWidth / 2

  // 边界检查：水平方向
  if (left < pad) left = pad
  if (left + popupWidth > vw - pad) left = vw - popupWidth - pad

  // 垂直方向：优先放在单词下方
  let top = wordRect.bottom + gap

  // 如果下方空间不足，放在单词上方
  if (top + popupHeight > vh - pad) {
    top = wordRect.top - popupHeight - gap
  }

  // 最终边界检查
  if (top < pad) top = pad
  if (top + popupHeight > vh - pad) top = vh - popupHeight - pad

  // 更新样式（一步到位，无闪烁）
  popupStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    opacity: 1
  }
}
</script>

<template>
  <div
    ref="popupRef"
    class="fixed z-50 bg-white dark:bg-neutral-900 transition-opacity duration-150"
    :class="isMobile
      ? 'bottom-0 inset-x-0 rounded-t-2xl border-t border-gray-200 dark:border-neutral-800 max-h-[80vh] overflow-y-auto shadow-[0_-8px_30px_rgba(0,0,0,0.15)]'
      : 'rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 w-64 max-h-[75vh] overflow-y-auto'"
    :style="isMobile ? {} : popupStyle"
  >
    <div class="flex justify-center pt-2 sm:hidden">
      <div class="w-10 h-1 rounded-full bg-gray-300 dark:bg-neutral-700"></div>
    </div>
    <div class="p-3">
      <div class="flex items-start gap-2 mb-2">
        <div class="flex items-baseline gap-2 flex-1 min-w-0">
          <span class="text-lg font-bold text-gray-900 dark:text-neutral-100">{{ word }}</span>
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
          @click="$emit('close')"
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
          <div v-for="(def, i) in definitions" :key="i" class="text-sm">
            <span v-if="def.partOfSpeech" class="text-blue-600 dark:text-blue-400 font-medium">{{ def.partOfSpeech }}</span>
            <span class="text-gray-700 dark:text-neutral-300 ml-1">{{ def.meaning }}</span>
          </div>
        </div>

        <div v-if="loadingContext || contextTranslation || contextError" class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
          <div class="text-xs text-gray-500 dark:text-neutral-400 mb-1">在文中</div>
          <div v-if="loadingContext" class="py-2">
            <div class="animate-spin inline-block w-4 h-4 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
          </div>
          <div v-else-if="contextTranslation" class="text-sm text-gray-700 dark:text-neutral-300">
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
</template>
