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
// 对齐译文的从句片段：与英文从句容器对称的虚线边框 + 类型角标，内部为逐成分中文片段（children）
const props = defineProps({
  // 英文从句片段 { text, role, clause: { type, subtype, segments }, _id? }
  clauseSeg: { type: Object, required: true },
  // AI 逐成分译文 [{ enIndex, zh, children? }]，enIndex 对应 clause.clause.segments 下标
  children: { type: Array, required: true },
  // 该从句的对齐路径：顶层从句为 [i]，嵌套从句为 [i, j]…
  basePath: { type: Array, required: true }
})

// ---- 与 SelectionPopup 联动的交互状态（provide/inject） ----
const alignedActivePath = inject('grammarAlignedPath', null)          // 当前对齐激活的片段路径
const hoverFragment = inject('grammarHoverAlignedFragment', null)     // (path) 悬停中文片段
const leaveFragment = inject('grammarLeaveAlignedFragment', null)     // (path) 离开中文片段
const tapFragment = inject('grammarTapAlignedFragment', null)         // (path, event) 触屏点按锁定

// 路径匹配：a 是 b 的前缀（含相等）→ b 片段处于 a 的激活范围内
function pathPrefixOf(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length <= b.length && a.every((v, i) => v === b[i])
}

// 本从句处于对齐激活范围内（自身或祖先被激活：如英文侧对应从句整体被悬停）
const alignedActive = computed(() => pathPrefixOf(alignedActivePath?.value, props.basePath))

// 激活的是本从句内部的片段：边框激活但不加对齐描边
const descendantActive = computed(() =>
  pathPrefixOf(props.basePath, alignedActivePath?.value) &&
  !pathPrefixOf(alignedActivePath?.value, props.basePath)
)

// 从句容器：与英文从句容器一致（未激活虚线，激活实线 + 底色；对齐激活附加描边）
const clauseClass = computed(() => {
  const type = props.clauseSeg.clause?.type
  const border = CLAUSE_BORDER_CLASSES[type] || 'border-gray-400 dark:border-neutral-500'
  if (alignedActive.value) {
    return `${border} ${CLAUSE_ACTIVE_CLASSES[type] || ''} border-solid shadow-sm ring-1 ring-gray-900/40 dark:ring-white/60`
  }
  if (descendantActive.value) {
    return `${border} ${CLAUSE_ACTIVE_CLASSES[type] || ''} border-solid shadow-sm`
  }
  return `${border} border-dashed`
})

// 从句内部英文片段（children 项的对应源）
function childSeg(child) {
  return props.clauseSeg.clause?.segments?.[child.enIndex]
}

function childPath(child) {
  return props.basePath.concat(child.enIndex)
}

// 内部片段：按对应英文成分着色；对齐激活时加深 + 描边
function childClass(child) {
  const role = childSeg(child)?.role
  const base = role ? (ROLE_CLASSES[role] || '') : ''
  if (!pathPrefixOf(alignedActivePath?.value, childPath(child))) return base
  const active = role ? (ROLE_ACTIVE_CLASSES[role] || base) : 'bg-gray-200 dark:bg-neutral-600'
  return `${active} ring-1 ring-gray-900/40 dark:ring-white/60`
}
</script>

<template>
  <span
    class="relative inline border rounded-md px-1 py-0.5 box-decoration-clone"
    :class="clauseClass"
    @mouseenter="hoverFragment?.(basePath)"
    @mouseleave="leaveFragment?.(basePath)"
    @click="tapFragment?.(basePath, $event)"
  >
    <span
      class="absolute -top-2 left-0.5 z-10 px-1 py-px text-[10px] leading-tight font-medium text-white rounded-sm whitespace-nowrap"
      :class="CLAUSE_CHIP_CLASSES[clauseSeg.clause.type] || 'bg-gray-500'"
    >{{ clauseLabel(clauseSeg.clause) }}</span>
    <template v-for="child in children" :key="child.enIndex">
      <!-- 子片段自身为从句且带逐成分译文：递归渲染层次容器（整体译文可为空） -->
      <AlignedClause
        v-if="childSeg(child)?.clause && child.children?.some(c => c.zh)"
        :clause-seg="childSeg(child)"
        :children="child.children"
        :base-path="childPath(child)"
      />
      <!-- 普通子片段：按对应英文成分着色（空译文不渲染） -->
      <span
        v-else-if="child.zh"
        class="rounded px-0.5 cursor-default"
        :class="childClass(child)"
        @mouseenter="hoverFragment?.(childPath(child))"
        @mouseleave="leaveFragment?.(childPath(child))"
        @click="tapFragment?.(childPath(child), $event)"
      >{{ child.zh }}</span>
    </template>
  </span>
</template>
