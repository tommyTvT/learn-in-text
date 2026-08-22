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
  depth: { type: Number, default: 0 }
})

// ---- 与 SelectionChatModal 联动的交互状态（provide/inject，避免逐层透传） ----
const activeRole = inject('grammarActiveRole', null)                 // 当前高亮成分角色
const activeClauseId = inject('grammarActiveClauseId', null)         // 当前高亮从句 id
const hoverRole = inject('grammarHoverRole', null)                   // (role|null, event)
const hoverClause = inject('grammarHoverClause', null)               // (segment|null, event)
const tapRole = inject('grammarTapRole', null)                       // (role, event) 触屏点按锁定
const tapClause = inject('grammarTapClause', null)                   // (segment, event)

const isClause = computed(() => !!props.segment.clause)

// 叶子片段：成分配色 + 同成分同步高亮 / 其余淡出
const leafClass = computed(() => {
  const role = props.segment.role
  const base = ROLE_CLASSES[role] || ''
  const active = activeRole?.value
  if (!active) return base
  if (active === role) return ROLE_ACTIVE_CLASSES[role] || base
  return `opacity-70 ${base}`
})

// 从句容器是否处于激活态（自身被悬停/锁定）
const isClauseActive = computed(() => {
  if (!props.segment.clause) return false
  return !!activeClauseId?.value && props.segment._id === activeClauseId.value
})

// 从句容器：未激活虚线边框，激活后实线 + 底色加深
const clauseClass = computed(() => {
  const type = props.segment.clause?.type
  const border = CLAUSE_BORDER_CLASSES[type] || 'border-gray-400 dark:border-neutral-500'
  return isClauseActive.value
    ? `${border} ${CLAUSE_ACTIVE_CLASSES[type] || ''} border-solid shadow-sm`
    : `${border} border-dashed`
})
</script>

<template>
  <!-- 从句节点：虚线边框 + 左上角类型角标，内部递归渲染成分 -->
  <span
    v-if="isClause"
    class="relative inline border rounded-md px-1 py-0.5 box-decoration-clone"
    :class="clauseClass"
    @mouseenter="hoverClause?.(segment, $event)"
    @mouseleave="hoverClause?.(null, $event)"
    @click="tapClause?.(segment, $event)"
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
    />
  </span>
  <!-- 叶子片段：按句子成分着色 -->
  <span
    v-else
    class="rounded px-0.5"
    :class="leafClass"
    @mouseenter="hoverRole?.(segment.role, $event)"
    @mouseleave="hoverRole?.(null, $event)"
    @click="tapRole?.(segment.role, $event)"
  >{{ segment.text }}</span>
</template>
