<script setup>
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { MessageCircleQuestion } from 'lucide-vue-next'
import { parseSelectionComponents } from '../../services/ai'
import ClauseSegment from './ClauseSegment.vue'
import {
  ROLE_LABELS,
  ROLE_CHIP_CLASSES,
  CLAUSE_LEGEND_CHIP_CLASSES,
  clauseLabel
} from './grammarConstants'

const props = defineProps({
  text: String,
  translation: String,
  loading: Boolean,
  error: Boolean,
  // 选区上下文（前后文），供语法解析消歧
  context: String
})

const emit = defineEmits(['close', 'retry', 'ask'])

// ---- 句子成分解析（弹窗打开即默认触发） ----
const segments = ref([]) // [{ text, role, clause? }] 按原文顺序的成分片段（可嵌套从句）
const parsing = ref(false)
const parseError = ref(false)
let parseCtrl = null // 成分解析请求的 AbortController
let alive = true // 卸载守卫：组件卸载后不再更新状态

// ---- 悬停 / 点按联动状态（provide 给 ClauseSegment 递归组件） ----
const activeRole = ref(null)          // 当前高亮成分角色（悬停或触屏锁定）
const activeClauseId = ref(null)      // 当前高亮从句 id（悬停或触屏锁定）
const locked = ref(false)             // 触屏点按锁定（锁定时忽略悬停）
const isTouch = ref(false)

provide('grammarActiveRole', activeRole)
provide('grammarActiveClauseId', activeClauseId)
provide('grammarHoverRole', hoverRole)
provide('grammarHoverClause', hoverClause)
provide('grammarTapRole', tapRole)
provide('grammarTapClause', tapClause)

// ---- 悬停提示（固定槽位：显示在句子下方，浮层在多行文本中难免压字） ----
// 从句 id → { label, type }（assignClauseIds 时收集）
const clauseInfoById = new Map()

// 当前提示文本：悬停/点按成分或从句时显示对应名称
const hintText = computed(() => {
  if (activeRole.value) return ROLE_LABELS[activeRole.value] || ''
  if (activeClauseId.value) return clauseInfoById.get(activeClauseId.value)?.label || ''
  return ''
})

// 提示槽前缀色块：成分用角色实色块，从句用虚线描边块（示意从句边框样式）
const hintChipClass = computed(() => {
  if (activeRole.value) return ROLE_CHIP_CLASSES[activeRole.value] || ''
  const type = activeClauseId.value
    ? clauseInfoById.get(activeClauseId.value)?.type
    : null
  return type ? `border border-dashed ${CLAUSE_LEGEND_CHIP_CLASSES[type] || ''}` : ''
})

// ---- 联动高亮 ----
function clearActive() {
  activeRole.value = null
  activeClauseId.value = null
  locked.value = false
}

// 悬停成分片段：同角色片段同步高亮（名称在下方固定提示槽显示）
function hoverRole(role) {
  if (locked.value) return
  activeRole.value = role && ROLE_LABELS[role] ? role : null
}

// 悬停从句：整句范围高亮
function hoverClause(seg) {
  if (locked.value) return
  activeClauseId.value = seg ? seg._id || null : null
}

// 触屏点按成分片段：切换锁定
function tapRole(role, event) {
  if (!isTouch.value || !ROLE_LABELS[role]) return
  event?.stopPropagation?.()
  if (locked.value && activeRole.value === role) {
    clearActive()
    return
  }
  clearActive()
  activeRole.value = role
  locked.value = true
}

// 触屏点按从句：切换锁定
function tapClause(seg, event) {
  if (!isTouch.value) return
  event?.stopPropagation?.()
  if (locked.value && seg && activeClauseId.value === seg._id) {
    clearActive()
    return
  }
  clearActive()
  activeClauseId.value = seg?._id || null
  locked.value = true
}

// ---- 图例反向联动 ----
function legendEnterRole(role) {
  if (locked.value) return
  activeRole.value = role
}

function legendLeave() {
  if (locked.value) return
  activeRole.value = null
}

function tapLegendRole(role, event) {
  if (!isTouch.value) return
  event?.stopPropagation?.()
  if (locked.value && activeRole.value === role) {
    clearActive()
    return
  }
  clearActive()
  activeRole.value = role
  locked.value = true
}

// 点击解析区空白处解除触屏锁定
function handlePanelClick() {
  if (locked.value) clearActive()
}

// ---- 解析结果遍历工具 ----
function walkSegments(segs, fn) {
  for (const seg of segs || []) {
    fn(seg)
    if (seg.clause) walkSegments(seg.clause.segments, fn)
  }
}

// 为从句节点分配唯一 id（悬停联动标识），并收集 id → 名称/类型映射供提示槽使用
function assignClauseIds(segs, prefix = 'c') {
  let i = 0
  for (const seg of segs || []) {
    if (seg.clause) {
      seg._id = `${prefix}${i++}`
      clauseInfoById.set(seg._id, { label: clauseLabel(seg.clause), type: seg.clause.type })
      assignClauseIds(seg.clause.segments, `${seg._id}-`)
    }
  }
}

// 句中实际出现的成分（图例只展示用到的）
const usedRoles = computed(() => {
  const set = new Set()
  walkSegments(segments.value, seg => {
    if (ROLE_LABELS[seg.role]) set.add(seg.role)
  })
  return [...set]
})

async function runParse() {
  parsing.value = true
  parseError.value = false
  segments.value = []
  clauseInfoById.clear()
  clearActive()
  parseCtrl = new AbortController()
  try {
    const result = await parseSelectionComponents(props.text, props.context, parseCtrl.signal)
    if (!alive) return
    assignClauseIds(result.segments)
    segments.value = result.segments
  } catch (error) {
    if (!alive || error?.name === 'AbortError') return
    console.error('句子成分解析失败:', error.message)
    parseError.value = true
  } finally {
    parseCtrl = null
    if (alive) {
      parsing.value = false
    }
  }
}

function retryParse() {
  if (parsing.value) return
  runParse()
}

const isMobile = ref(false)
let mq = null

// 移动端底部弹出/收起动画状态
const entering = ref(true)
const closing = ref(false)

const handleMqChange = (e) => {
  isMobile.value = e.matches
}

onMounted(() => {
  mq = window.matchMedia('(max-width: 639px)')
  isMobile.value = mq.matches
  if (mq.addEventListener) {
    mq.addEventListener('change', handleMqChange)
  } else {
    mq.addListener(handleMqChange)
  }
  // 移动端：触发从下方滑入动画
  if (isMobile.value) {
    requestAnimationFrame(() => {
      entering.value = false
    })
  }
  // 句子成分解析为默认功能，弹窗打开即触发
  isTouch.value = window.matchMedia('(pointer: coarse)').matches
  runParse()
})

onUnmounted(() => {
  alive = false
  parseCtrl?.abort()
  if (mq) {
    if (mq.removeEventListener) {
      mq.removeEventListener('change', handleMqChange)
    } else {
      mq.removeListener(handleMqChange)
    }
  }
})

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
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
    <!-- 灰色遮罩：点击关闭 -->
    <div class="absolute inset-0 bg-black/40" @click="startClose"></div>

    <!-- 独立界面：移动端底部弹出，PC 端居中大卡片 -->
    <div
      class="relative w-full sm:max-w-3xl bg-white dark:bg-neutral-900 rounded-t-2xl sm:rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 flex flex-col min-h-[30vh] sm:min-h-0 max-h-[85vh] sm:max-h-[80vh]"
      :class="isMobile
        ? [
            'transition-transform duration-300 ease-out',
            entering || closing ? 'translate-y-full' : 'translate-y-0'
          ]
        : 'transition-opacity duration-150'"
    >
      <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="flex justify-center pt-2 sm:hidden">
          <div class="w-10 h-1 rounded-full bg-gray-300 dark:bg-neutral-700"></div>
        </div>
        <div class="p-4 pb-4 sm:p-5 sm:pb-5">
          <!-- 标题行：语法解析 -->
          <div class="flex items-center justify-between mb-1">
            <span class="text-sm font-medium text-gray-500 dark:text-neutral-400">语法解析</span>
            <div class="flex items-center gap-2">
              <!-- 语法追问：进入追问对话 -->
              <button
                @click.stop="$emit('ask')"
                class="p-0.5 -m-0.5 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                title="语法追问（针对原文提问）"
                aria-label="语法追问"
              >
                <MessageCircleQuestion class="w-4 h-4" />
              </button>
              <button
                @click.stop="startClose"
                class="p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200"
                aria-label="关闭"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 语法解析：划词后自动加载（置于原原文位置） -->
          <div
            class="bg-gray-50 dark:bg-neutral-800/60 rounded-md px-3 py-2"
            @click="handlePanelClick"
          >
            <template v-if="segments.length">
              <!-- 行内标注：成分着色 + 从句边框/角标，递归渲染（限高滚动） -->
              <p class="text-sm leading-loose break-words max-h-64 overflow-y-auto">
                <ClauseSegment v-for="(seg, i) in segments" :key="i" :segment="seg" />
              </p>

              <!-- 悬停/点按提示：句子下方固定槽位（恒定高度，不遮挡阅读内容） -->
              <div
                class="h-5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400 transition-opacity duration-150 select-none"
                :class="hintText ? 'opacity-100' : 'opacity-0'"
              >
                <span class="inline-block w-2.5 h-2.5 rounded-sm shrink-0" :class="hintChipClass"></span>
                <span>{{ hintText }}</span>
              </div>

              <!-- 图例：句子成分（悬停/点按联动高亮；从句类型由句中角标展示，不重复列出） -->
              <div v-if="usedRoles.length" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  v-for="role in usedRoles"
                  :key="role"
                  class="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-neutral-400 cursor-default rounded px-0.5 -m-0.5"
                  :class="{ 'ring-1 ring-gray-300 dark:ring-neutral-500': activeRole === role }"
                  @mouseenter="legendEnterRole(role)"
                  @mouseleave="legendLeave"
                  @click="tapLegendRole(role, $event)"
                >
                  <span class="inline-block w-2.5 h-2.5 rounded-sm" :class="ROLE_CHIP_CLASSES[role]"></span>
                  {{ ROLE_LABELS[role] }}
                </span>
              </div>
            </template>
            <!-- 解析中/失败：展示原文（全部展开，限高滚动） -->
            <p
              v-else
              class="text-sm text-gray-600 dark:text-neutral-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
            >{{ text }}</p>
          </div>
          <!-- 句子成分解析状态 -->
          <div v-if="parsing" class="flex items-center gap-2 mt-2">
            <div class="animate-spin inline-block w-4 h-4 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
            <span class="text-xs text-gray-400 dark:text-neutral-500">正在解析句子成分…</span>
          </div>
          <div v-else-if="parseError" class="flex items-center gap-2 mt-2">
            <span class="text-xs text-red-500 dark:text-red-400">句子成分解析失败</span>
            <button
              @click="retryParse"
              class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
            >重试</button>
          </div>

          <!-- 译文 -->
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
        </div>
      </div>

    </div>
  </div>
</template>
