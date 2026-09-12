<script setup>
import { ref, computed, onMounted, onUnmounted, provide } from 'vue'
import { MessageCircleQuestion } from 'lucide-vue-next'
import { parseSelectionComponents, generateAlignedTranslation } from '../../services/ai'
import { errorText } from '../../services/errors'
import { useDialogA11y } from '../../composables/useDialogA11y'
import ClauseSegment from './ClauseSegment.vue'
import AlignedClause from './AlignedClause.vue'
import {
  ROLE_LABELS,
  ROLE_CLASSES,
  ROLE_ACTIVE_CLASSES,
  ROLE_CHIP_CLASSES,
  CLAUSE_LEGEND_CHIP_CLASSES,
  clauseLabel
} from './grammarConstants'

const props = defineProps({
  text: String,
  translation: String,
  loading: Boolean,
  // 兼容布尔（旧用法：仅表示失败）与字符串（失败原因，可直接展示）
  error: [Boolean, String],
  // 选区上下文（前后文），供语法解析消歧
  context: String
})

const emit = defineEmits(['close', 'retry', 'ask'])

// 弹窗无障碍：Esc 关闭（复用带移动端收起动画的 startClose）、焦点移入/归还、Tab 循环。
// 本组件挂载即打开（父级 v-if 控制显隐）。
const panelRef = ref(null)
useDialogA11y({
  isOpen: () => true,
  onClose: () => startClose(),
  panelRef
})

// ---- 句子成分解析（弹窗打开即默认触发） ----
const segments = ref([]) // [{ text, role, clause? }] 按原文顺序的成分片段（可嵌套从句）
const parsing = ref(false)
const parseError = ref(false)
// 失败原因（空串时回退通用文案）：把 AI 抛出的可行动消息（未配置接口 / 鉴权失败 / 超时）透出，
// 否则用户只会看到「XX 失败」+ 重试的死循环
const parseErrorMsg = ref('')

/** 对外 error prop 的展示文案（兼容布尔） */
const translationErrorText = computed(() => {
  const e = props.error
  return typeof e === 'string' && e ? e : '翻译失败'
})
const parseErrorText = computed(() => parseErrorMsg.value || '句子成分解析失败')
let parseCtrl = null // 成分解析请求的 AbortController
let alive = true // 卸载守卫：组件卸载后不再更新状态

// ---- 悬停 / 点按联动状态（provide 给 ClauseSegment 递归组件） ----
// activeRole 仅由图例触发（同 role 片段全亮）；悬停/点按具体片段走 alignedActivePath 精确激活
const activeRole = ref(null)          // 当前高亮成分角色（图例悬停或触屏锁定）
const locked = ref(false)             // 触屏点按锁定（锁定时忽略悬停）
const isTouch = ref(false)

provide('grammarActiveRole', activeRole)

// ---- 译文模式：对应（成分对齐）/ 自然，localStorage 记忆用户选择 ----
const TRANSLATION_MODE_KEY = 'selection-translation-mode'
const translationMode = ref(
  localStorage.getItem(TRANSLATION_MODE_KEY) === 'natural' ? 'natural' : 'aligned'
)

function setTranslationMode(mode) {
  if (translationMode.value === mode) return
  translationMode.value = mode
  try {
    localStorage.setItem(TRANSLATION_MODE_KEY, mode)
  } catch {
    // 持久化失败（如隐私模式）时仅本次会话生效
  }
}

// ---- 对齐翻译（「英式中文」：每个英文成分对应一个中文片段，从句内部成分逐个对应） ----
const alignedSegments = ref([]) // [{ enIndex, zh, children? }] 按中文语序，enIndex 指向顶层英文片段下标；children 为从句内部逐成分译文
const alignedLoading = ref(false)
const alignedError = ref(false)
const alignedErrorMsg = ref('')
const alignedErrorText = computed(() => alignedErrorMsg.value || '对应译文生成失败')
let alignedCtrl = null // 对齐翻译请求的 AbortController

// 对齐联动状态：英文片段 ↔ 中文片段 双向高亮（按对齐路径：顶层 [i]，从句内部 [i, j]…）
// 悬停/点按任何具体片段（英文或中文侧）都精确激活该片段，不再触发同 role 全亮
const alignedActivePath = ref(null)  // 当前对齐激活的片段路径
const alignedLocked = ref(false)     // 触屏点按锁定（锁定时忽略悬停）

provide('grammarAlignedPath', alignedActivePath)
provide('grammarHoverAligned', hoverAligned)
provide('grammarTapAligned', tapAligned)
// 中文侧从句层次容器（AlignedClause）联动
provide('grammarHoverAlignedFragment', hoverAlignedFragment)
provide('grammarLeaveAlignedFragment', leaveAlignedFragment)
provide('grammarTapAlignedFragment', tapAlignedFragment)

// ---- 对齐路径工具 ----
function pathEquals(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
}

function pathPrefixOf(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length <= b.length && a.every((v, i) => v === b[i])
}

// 按路径取英文片段：[i] 顶层片段，[i, j] 从句内部片段（嵌套类推）
function findSegmentByPath(path) {
  let list = segments.value
  let seg = null
  for (const idx of path || []) {
    seg = list?.[idx]
    if (!seg) return null
    list = seg.clause?.segments
  }
  return seg
}

// 悬停英文片段（ClauseSegment 上报）时设置对齐联动：精确激活该片段
function hoverAligned(path) {
  if (alignedLocked.value) return
  alignedActivePath.value = path ?? null
}

// 触屏点按片段（英文/中文侧共用）：切换精确路径锁定（同时清除图例的同 role 锁定）
function tapAligned(path, event) {
  if (!isTouch.value) return
  event?.stopPropagation?.()
  if (alignedLocked.value && pathEquals(alignedActivePath.value, path)) {
    clearActive()
    return
  }
  clearActive()
  alignedActivePath.value = path
  alignedLocked.value = true
  locked.value = true
}

// 悬停中文片段：精确高亮对应英文片段（从句容器由路径前缀匹配自动激活）
function hoverAlignedFragment(path) {
  if (alignedLocked.value) return
  alignedActivePath.value = path || null
}

// 离开中文片段：从句内部片段回退到从句整体，顶层片段清除联动
function leaveAlignedFragment(path) {
  if (alignedLocked.value) return
  const parent = path?.length > 1 ? path.slice(0, -1) : null
  alignedActivePath.value = parent
}

// 触屏点按中文片段：与点按英文片段同一套精确锁定逻辑
function tapAlignedFragment(path, event) {
  tapAligned(path, event)
}

// 中文片段样式：按对应英文成分着色；对齐激活时加深 + 描边
function alignedFragmentClass(path) {
  const seg = findSegmentByPath(path)
  const role = seg?.role
  const base = role ? (ROLE_CLASSES[role] || '') : ''
  if (!pathPrefixOf(alignedActivePath.value, path)) return base
  const active = role ? (ROLE_ACTIVE_CLASSES[role] || base) : 'bg-gray-200 dark:bg-neutral-600'
  return `${active} ring-1 ring-gray-900/40 dark:ring-white/60`
}

// 从句片段是否有可渲染的逐成分译文（children 至少一个非空 zh，且对应英文片段确为从句）
function hasAlignedChildren(frag) {
  return !!(
    frag.children?.length &&
    frag.children.some(c => c.zh) &&
    segments.value[frag.enIndex]?.clause
  )
}

// 对齐视图状态机：片段 / 加载中 / 失败 / 回退自然译文（含自然模式）
const alignedView = computed(() => {
  if (translationMode.value !== 'aligned') return 'off'
  if (parsing.value || alignedLoading.value) return 'loading'
  if (alignedError.value) return 'error'
  if (alignedSegments.value.length) return 'segments'
  return 'fallback'
})

async function runAlignedTranslation(topSegments) {
  alignedLoading.value = true
  alignedError.value = false
  alignedErrorMsg.value = ''
  alignedSegments.value = []
  clearActive()
  alignedCtrl = new AbortController()
  try {
    const result = await generateAlignedTranslation(props.text, topSegments, props.context, alignedCtrl.signal)
    if (!alive) return
    // 空串片段（虚词等无实义对应）不渲染；从句片段有逐成分译文（children）时整体译文可为空
    alignedSegments.value = result.segments.filter(s => s.zh || hasAlignedChildren(s))
  } catch (error) {
    if (!alive || error?.name === 'AbortError') return
    console.error('对应译文生成失败:', error)
    alignedError.value = true
    alignedErrorMsg.value = errorText(error, '')
  } finally {
    alignedCtrl = null
    if (alive) {
      alignedLoading.value = false
    }
  }
}

function retryAligned() {
  if (alignedLoading.value || parsing.value) return
  // 成分解析成功仅对齐失败 → 重试对齐翻译；否则从成分解析重新开始
  if (segments.value.length) {
    runAlignedTranslation(segments.value)
  } else {
    retryParse()
  }
}

// ---- 悬停提示（固定槽位：显示在句子下方，浮层在多行文本中难免压字） ----
// 从句 id → { label, type }（assignClauseIds 时收集）
const clauseInfoById = new Map()

// 当前提示文本：图例联动显示成分名；精确激活显示对应片段的成分名 / 从句名
const hintText = computed(() => {
  if (activeRole.value) return ROLE_LABELS[activeRole.value] || ''
  if (alignedActivePath.value) {
    const seg = findSegmentByPath(alignedActivePath.value)
    if (seg?.clause) return clauseInfoById.get(seg._id)?.label || ''
    if (seg) return ROLE_LABELS[seg.role] || ''
  }
  return ''
})

// 提示槽前缀色块：成分用角色实色块，从句用虚线描边块（示意从句边框样式）
const hintChipClass = computed(() => {
  if (activeRole.value) return ROLE_CHIP_CLASSES[activeRole.value] || ''
  if (alignedActivePath.value) {
    const seg = findSegmentByPath(alignedActivePath.value)
    if (seg?.clause) return `border border-dashed ${CLAUSE_LEGEND_CHIP_CLASSES[seg.clause.type] || ''}`
    if (seg) return ROLE_CHIP_CLASSES[seg.role] || ''
  }
  return ''
})

// ---- 联动高亮 ----
function clearActive() {
  activeRole.value = null
  locked.value = false
  alignedActivePath.value = null
  alignedLocked.value = false
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
  if (locked.value || alignedLocked.value) clearActive()
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
  parseErrorMsg.value = ''
  segments.value = []
  // 重新解析时旧对齐译文失效：中止进行中的请求并清空状态
  alignedSegments.value = []
  alignedError.value = false
  alignedErrorMsg.value = ''
  alignedCtrl?.abort()
  clauseInfoById.clear()
  clearActive()
  parseCtrl = new AbortController()
  try {
    const result = await parseSelectionComponents(props.text, props.context, parseCtrl.signal)
    if (!alive) return
    assignClauseIds(result.segments)
    segments.value = result.segments
    // 解析成功后自动预加载对应译文（「对应」模式即取即用）
    runAlignedTranslation(result.segments)
  } catch (error) {
    if (!alive || error?.name === 'AbortError') return
    console.error('句子成分解析失败:', error)
    parseError.value = true
    parseErrorMsg.value = errorText(error, '')
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
  alignedCtrl?.abort()
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

    <!-- 独立界面：移动端底部弹出（比单词翻译抽屉更高），PC 端居中大卡片 -->
    <div
      ref="panelRef"
      role="dialog"
      aria-modal="true"
      aria-label="划词翻译"
      class="relative w-full sm:max-w-3xl bg-white dark:bg-neutral-900 rounded-t-2xl sm:rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 flex flex-col min-h-[60vh] sm:min-h-0 max-h-[90vh] sm:max-h-[80vh]"
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
              <!-- 行内标注：成分着色 + 从句边框/角标，递归渲染（限高滚动）；alignedPath 供对齐联动 -->
              <p class="text-sm leading-loose break-words max-h-64 overflow-y-auto">
                <ClauseSegment v-for="(seg, i) in segments" :key="i" :segment="seg" :aligned-path="[i]" />
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
          <div v-else-if="parseError" class="flex items-start gap-2 mt-2">
            <span class="text-xs text-red-500 dark:text-red-400">{{ parseErrorText }}</span>
            <button
              @click="retryParse"
              class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
            >重试</button>
          </div>

          <!-- 译文：对应（成分对齐）/ 自然 两种模式，切换有记忆 -->
          <div class="mt-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
            <div class="flex items-center justify-between mb-1">
              <span class="text-sm font-medium text-gray-500 dark:text-neutral-400">译文</span>
              <div class="flex items-center rounded-md border border-gray-200 dark:border-neutral-700 text-xs overflow-hidden">
                <button
                  @click="setTranslationMode('aligned')"
                  class="px-2 py-0.5 transition-colors"
                  :class="translationMode === 'aligned'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200'"
                  title="逐成分对应的「英式中文」译文，悬浮可联动高亮"
                >对应</button>
                <button
                  @click="setTranslationMode('natural')"
                  class="px-2 py-0.5 transition-colors"
                  :class="translationMode === 'natural'
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200'"
                  title="自然流畅的中文翻译"
                >自然</button>
              </div>
            </div>

            <!-- 对应模式：成分对齐片段，与上方英文成分双向悬浮高亮；从句渲染为层次容器（内部逐成分片段） -->
            <p
              v-if="alignedView === 'segments'"
              class="text-base sm:text-sm leading-loose break-words"
            >
              <template v-for="frag in alignedSegments" :key="frag.enIndex">
                <!-- 从句片段：与英文从句对称的边框 + 角标，内部为从句逐成分中文片段 -->
                <AlignedClause
                  v-if="hasAlignedChildren(frag)"
                  :clause-seg="segments[frag.enIndex]"
                  :children="frag.children"
                  :base-path="[frag.enIndex]"
                />
                <!-- 普通片段 -->
                <span
                  v-else
                  class="rounded px-0.5 cursor-default"
                  :class="alignedFragmentClass([frag.enIndex])"
                  @mouseenter="hoverAlignedFragment([frag.enIndex])"
                  @mouseleave="leaveAlignedFragment([frag.enIndex])"
                  @click="tapAlignedFragment([frag.enIndex], $event)"
                >{{ frag.zh }}</span>
              </template>
            </p>
            <!-- 对应模式加载中：成分解析阶段由上方状态行承担 spinner 与文案，
                 这里只补一句「等待」提示，避免同屏两处相同文案 + 两个 spinner -->
            <div v-else-if="alignedView === 'loading'" class="flex items-center gap-2 py-2">
              <div v-if="!parsing" class="animate-spin inline-block w-4 h-4 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
              <span class="text-xs text-gray-400 dark:text-neutral-500">{{ parsing ? '等待成分解析完成…' : '正在生成对应译文…' }}</span>
            </div>
            <!-- 对应模式失败 -->
            <div v-else-if="alignedView === 'error'" class="flex items-start gap-2 py-1">
              <span class="text-xs text-red-500 dark:text-red-400">{{ alignedErrorText }}</span>
              <button
                @click="retryAligned"
                class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
              >重试</button>
            </div>
            <!-- 自然模式 / 对应模式回退：自然译文 -->
            <template v-else>
              <p
                v-if="alignedView === 'fallback' && parseError"
                class="text-xs text-gray-400 dark:text-neutral-500 mb-1"
              >语法解析失败，已回退自然译文</p>
              <div v-if="loading" class="py-3 text-center">
                <div class="animate-spin inline-block w-5 h-5 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
              </div>
              <div v-else-if="error" class="flex items-start gap-2 py-1">
                <span class="text-xs text-red-500 dark:text-red-400">{{ translationErrorText }}</span>
                <button
                  @click="$emit('retry')"
                  class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
                >重试</button>
              </div>
              <p
                v-else-if="translation"
                class="text-base sm:text-sm text-gray-700 dark:text-neutral-300 whitespace-pre-wrap break-words"
              >{{ translation }}</p>
            </template>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>
