<script setup>
import { computed, inject } from 'vue'
import {
  ROLE_CLASSES,
  ROLE_ACTIVE_CLASSES,
  CLAUSE_BORDER_CLASSES,
  CLAUSE_CHIP_CLASSES,
  CLAUSE_ACTIVE_CLASSES,
  clauseLabel
} from './grammarConstants'

// 递归组件：SFC 可通过文件名在模板中自引用
const props = defineProps({
  // { text, role, clause?: { type, subtype, segments }, _id? }
  segment: { type: Object, required: true },
  depth: { type: Number, default: 0 },
  // 本片段的对齐路径：顶层片段为 [i]，从句内部片段为 [i, j]（嵌套类推）；null 表示无对齐上下文
  alignedPath: { type: Array, default: null }
})

// ---- 与 SelectionPopup 联动的交互状态（provide/inject，避免逐层透传） ----
const activeRole = inject('grammarActiveRole', null)                 // 图例触发的高亮成分角色（同 role 全亮）
// ---- 对齐翻译联动（英文片段 ↔ 中文对应片段双向高亮，按对齐路径匹配） ----
// 悬停/点按具体片段仅精确激活该片段（不再同 role 全亮，同 role 全亮仅由图例触发）
const alignedActivePath = inject('grammarAlignedPath', null)         // 当前对齐激活的片段路径
const hoverAligned = inject('grammarHoverAligned', null)             // (path|null)
const tapAligned = inject('grammarTapAligned', null)                 // (path, event) 触屏点按锁定

const isClause = computed(() => !!props.segment.clause)

// 路径匹配：a 是 b 的前缀（含相等）→ b 片段处于 a 的激活范围内
function pathPrefixOf(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length <= b.length && a.every((v, i) => v === b[i])
}

// 本片段处于对齐激活范围内（激活片段自身或其后代：如整个从句被对应中文片段悬停）
const alignedActive = computed(() => pathPrefixOf(alignedActivePath?.value, props.alignedPath))

// 激活的是本片段的后代（如从句内部片段被悬停）：从句容器边框激活但不加对齐描边
const alignedDescendantActive = computed(() =>
  pathPrefixOf(props.alignedPath, alignedActivePath?.value) &&
  !pathPrefixOf(alignedActivePath?.value, props.alignedPath)
)

// 叶子片段：成分配色；对齐激活（自身被悬停/点按或中文对应被悬停）加深 + 描边，
// 图例触发同 role 全亮；存在任意激活时其余片段淡出（含同 role 的其它片段）
const leafClass = computed(() => {
  const role = props.segment.role
  const base = ROLE_CLASSES[role] || ''
  if (alignedActive.value) {
    return `${ROLE_ACTIVE_CLASSES[role] || base} ring-1 ring-gray-900/40 dark:ring-white/60`
  }
  const active = activeRole?.value
  if (!active && !alignedActivePath?.value) return base
  if (active === role) return ROLE_ACTIVE_CLASSES[role] || base
  return `opacity-70 ${base}`
})

// 从句容器：未激活虚线边框；自身对齐激活时实线 + 底色加深 + 描边；
// 仅从句内部片段被对齐激活时（后代激活）边框变实线但不加描边
const clauseClass = computed(() => {
  const type = props.segment.clause?.type
  const border = CLAUSE_BORDER_CLASSES[type] || 'border-gray-400 dark:border-neutral-500'
  if (alignedActive.value) {
    return `${border} ${CLAUSE_ACTIVE_CLASSES[type] || ''} border-solid shadow-sm ring-1 ring-gray-900/40 dark:ring-white/60`
  }
  if (alignedDescendantActive.value) {
    return `${border} ${CLAUSE_ACTIVE_CLASSES[type] || ''} border-solid shadow-sm`
  }
  return `${border} border-dashed`
})

// ---- 事件转发：对齐联动（对齐路径随嵌套递进，从句内部片段有自己的路径） ----
function onClauseEnter() {
  if (props.alignedPath) hoverAligned?.(props.alignedPath)
}

function onClauseLeave() {
  // 顶层片段离开清除对齐联动；嵌套片段离开回退到父级整体（鼠标仍在外层容器内）
  if (props.depth === 0) {
    hoverAligned?.(null)
  } else if (props.alignedPath?.length > 1) {
    hoverAligned?.(props.alignedPath.slice(0, -1))
  }
}

function onClauseTap(event) {
  if (props.alignedPath) tapAligned?.(props.alignedPath, event)
}

function onLeafEnter() {
  if (props.alignedPath) hoverAligned?.(props.alignedPath)
}

function onLeafLeave() {
  // 顶层片段离开清除对齐联动；嵌套叶子离开回退到所属从句整体
  if (props.depth === 0) {
    hoverAligned?.(null)
  } else if (props.alignedPath?.length > 1) {
    hoverAligned?.(props.alignedPath.slice(0, -1))
  }
}

function onLeafTap(event) {
  if (props.alignedPath) tapAligned?.(props.alignedPath, event)
}
</script>

<template>
  <!-- 从句节点：虚线边框 + 左上角类型角标，内部递归渲染成分 -->
  <span
    v-if="isClause"
    class="relative inline border rounded-md px-1 py-0.5 box-decoration-clone"
    :class="clauseClass"
    @mouseenter="onClauseEnter"
    @mouseleave="onClauseLeave"
    @click="onClauseTap"
  >
    <span
      class="absolute -top-2 left-0.5 z-10 px-1 py-px text-[10px] leading-tight font-medium text-white rounded-sm whitespace-nowrap"
      :class="CLAUSE_CHIP_CLASSES[segment.clause.type] || 'bg-gray-500'"
    >{{ clauseLabel(segment.clause) }}</span>
    <ClauseSegment
      v-for="(child, i) in segment.clause.segments"
      :key="i"
      :segment="child"
      :depth="depth + 1"
      :aligned-path="alignedPath ? alignedPath.concat(i) : null"
    />
  </span>
  <!-- 叶子片段：按句子成分着色 -->
  <span
    v-else
    class="rounded px-0.5"
    :class="leafClass"
    @mouseenter="onLeafEnter"
    @mouseleave="onLeafLeave"
    @click="onLeafTap"
  >{{ segment.text }}</span>
</template>
