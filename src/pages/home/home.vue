<script setup>
import { onMounted, onBeforeUnmount, nextTick, ref, watch } from 'vue'
import { useRouter, usePageRoute } from '../../composables/routerShim'
import PageLayout from '../../components/Common/PageLayout.vue'
import Sortable from 'sortablejs'
import { GripVertical } from 'lucide-vue-next'
import { useArticleStore } from '../../stores/article'
import { useWordStore } from '../../stores/word'
import EditArticleModal from '../../components/Article/EditArticleModal.vue'
import { alert, confirmDialog } from '../../services/dialog'

usePageRoute()
const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()

const listRef = ref(null)
let sortable = null

// 设备是否支持触摸。支持触摸时完全不启用 SortableJS，改用下面的 Touch 事件实现：
// SortableJS 在 uni-app H5 的触摸链路上会被拦掉（它的 _onTapStart 以
// `evt.cancelable` 作为入口判断，且原生 HTML5 DnD 在触摸下没有 dragstart /
// dataTransfer），表现为按住六点手柄毫无反应。
// 用 maxTouchPoints / ontouchstart 而不是 `(pointer: fine)`：Chrome DevTools
// 的触摸模拟不会改变 pointer 媒体特性，用它判断会让手机调试时又走回 Sortable。
const hasTouchSupport =
  typeof window !== 'undefined' &&
  (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)

function setupSortable() {
  if (hasTouchSupport || sortable || !listRef.value) return
  sortable = new Sortable(listRef.value, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'article-drag-ghost',
    // 桌面端统一用 fallback 克隆体：与原生 HTML5 DnD 相比，克隆体的
    // 尺寸/定位完全由 Sortable 接管，跨浏览器观感一致
    forceFallback: true,
    fallbackOnBody: true,
    onEnd(evt) {
      const from = evt.oldIndex
      const to = evt.newIndex
      if (from == null || to == null || from === to) return
      nextTick(() => {
        articleStore.moveArticle(from, to)
      })
    }
  })
}

/* ============================================================
   移动端触摸拖拽排序（自实现，不依赖 SortableJS）
   原理：手柄上有 touch-action:none，浏览器不会用它开始页面滚动；
   触摸事件又只会派发给 touchstart 的原始目标，所以整个拖拽过程
   都收在 .drag-handle 自己的 touchmove 里，无需监听 document。
   - 6px 启动阈值：轻点/误触手柄不会进入拖拽
   - 拖拽中克隆一份「浮层」跟随手指，原行留作半透明占位符
   - 顺序变化时用 FLIP 让其它行滑到新位置，而不是瞬间跳位
   ============================================================ */
const touchDragIndex = ref(-1)
let touchDrag = null
let dragCloneEl = null
let orderDirty = false
let autoScrollRaf = null
// 刚结束拖拽的一小段时间内屏蔽列表项的点击（避免松手瞬间跳进文章）
let suppressClickUntil = 0

function onHandleTouchStart(e, index) {
  if (e.touches.length !== 1) return
  const t = e.touches[0]
  const itemEl = e.currentTarget?.closest('.article-item') || null
  touchDrag = {
    index,
    itemEl,
    startY: t.clientY,
    lastY: t.clientY,
    active: false
  }
  touchDragIndex.value = index
}

function onHandleTouchMove(e) {
  if (!touchDrag) return
  const t = e.touches[0]
  touchDrag.lastY = t.clientY
  if (!touchDrag.active) {
    if (Math.abs(t.clientY - touchDrag.startY) < 6) return
    touchDrag.active = true
    createDragClone()
    startAutoScroll()
  }
  // touch-action:none 已阻止滚动，这里再兜底一次
  if (e.cancelable) e.preventDefault()
  moveDragClone(t.clientY)
  applyDropIndex(t.clientY)
}

function onHandleTouchEnd() {
  stopAutoScroll()
  removeDragClone()
  if (touchDrag?.active && orderDirty) {
    orderDirty = false
    suppressClickUntil = Date.now() + 300
    articleStore.persistArticleOrder()
  }
  touchDrag = null
  touchDragIndex.value = -1
}

/* ---------- 跟随手指的拖拽浮层 ----------
   直接 cloneNode 复制整行挂到 body：这样浮层的排版/文字与被拖的行完全一致，
   不必在模板里再维护一份重复结构；克隆体会带上 scoped 的 data-v 属性，
   组件里的 .drag-clone 样式依然能命中。 */
function createDragClone() {
  const item = touchDrag?.itemEl
  if (!item || !item.parentNode) return
  const rect = item.getBoundingClientRect()
  const clone = item.cloneNode(true)
  // 原行此刻已带「占位符」样式，克隆体必须去掉，否则浮层也是半透明的
  clone.classList.remove('is-dragging')
  clone.classList.add('drag-clone')
  clone.style.position = 'fixed'
  clone.style.left = `${rect.left}px`
  clone.style.top = `${rect.top}px`
  clone.style.width = `${rect.width}px`
  clone.style.margin = '0'
  clone.style.pointerEvents = 'none'
  clone.style.zIndex = '60'
  document.body.appendChild(clone)
  dragCloneEl = clone
}

function moveDragClone(clientY) {
  if (!dragCloneEl) return
  // 浮层用 fixed 定位在视口坐标里，位移只取手指相对起点的差量：
  // 这样拖到边缘触发页面自动滚动时，浮层依然稳稳跟手
  dragCloneEl.style.transform = `translate3d(0, ${clientY - touchDrag.startY}px, 0)`
}

function removeDragClone() {
  if (dragCloneEl) dragCloneEl.remove()
  dragCloneEl = null
}

/** 按手指位置实时换位（拖拽中与自动滚动后都要调用） */
function applyDropIndex(clientY) {
  const target = resolveDropIndex(touchDrag.index, clientY)
  if (target === touchDrag.index) return
  const container = listRef.value
  const firstTops = new Map()
  if (container) {
    for (const child of container.children) firstTops.set(child, child.offsetTop)
  }
  articleStore.applyArticleOrder(touchDrag.index, target)
  touchDrag.index = target
  touchDragIndex.value = target
  orderDirty = true
  if (container) playFlip(container, firstTops)
}

/* FLIP：先记下每行的布局位置，DOM 更新后把差值反向写成初始 transform，
   下一帧再收起 transform，让它带过渡滑到新位置。
   ⚠️ 位置一律取 offsetTop（纯布局值）而不是 getBoundingClientRect：
   后者含有正在播放的动画 transform，手指快速连续换位时会把位移算重。 */
function playFlip(container, firstTops) {
  nextTick(() => {
    for (const child of container.children) {
      const before = firstTops.get(child)
      if (before == null) continue
      const delta = before - child.offsetTop
      if (!delta) continue
      child.style.transition = 'none'
      child.style.transform = `translateY(${delta}px)`
      // 强制回流，让初始位移先生效，否则会被下面的改动合并掉、动画不出现
      child.getBoundingClientRect()
      child.style.transition = 'transform 0.18s cubic-bezier(0.32, 0.72, 0, 1)'
      child.style.transform = ''
    }
  })
}

/* 拖到屏幕上下边缘时自动滚动页面，否则无法把文章移到可视区之外。
   列表随页面滚动后，落点需要按新的行位置重算。 */
const AUTO_SCROLL_EDGE = 72

function startAutoScroll() {
  if (autoScrollRaf) return
  const step = () => {
    if (!touchDrag?.active) {
      autoScrollRaf = null
      return
    }
    const y = touchDrag.lastY
    const h = window.innerHeight
    let dy = 0
    if (y < AUTO_SCROLL_EDGE) dy = -Math.ceil((AUTO_SCROLL_EDGE - y) / 5)
    else if (y > h - AUTO_SCROLL_EDGE) dy = Math.ceil((y - (h - AUTO_SCROLL_EDGE)) / 5)
    if (dy) {
      const scroller = document.scrollingElement || document.documentElement
      scroller.scrollTop += dy
      applyDropIndex(y)
    }
    autoScrollRaf = requestAnimationFrame(step)
  }
  autoScrollRaf = requestAnimationFrame(step)
}

function stopAutoScroll() {
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf)
  autoScrollRaf = null
}

/**
 * 依据手指纵坐标求目标插入位置：从当前位置沿移动方向逐个比较行中点。
 * y 取「相对列表容器」的坐标，行位置取 offsetTop / offsetHeight（纯布局值），
 * 因此不受换位动画 transform 的影响，连续快速换位也不会算错。
 * （容器自身是 static，与列表项共享 offsetParent，故 offsetTop 可直接相减）
 */
function resolveDropIndex(current, clientY) {
  const container = listRef.value
  if (!container) return current
  const items = Array.from(container.children)
  if (!items[current]) return current
  const y = clientY - container.getBoundingClientRect().top
  const topOf = (el) => el.offsetTop - container.offsetTop
  const midOf = (el) => topOf(el) + el.offsetHeight / 2
  const bottomOf = (el) => topOf(el) + el.offsetHeight
  let target = current
  if (y < topOf(items[current])) {
    for (let i = current - 1; i >= 0; i--) {
      if (y < midOf(items[i])) target = i
      else break
    }
  } else if (y > bottomOf(items[current])) {
    for (let i = current + 1; i < items.length; i++) {
      if (y > midOf(items[i])) target = i
      else break
    }
  }
  return target
}

onMounted(async () => {
  await articleStore.fetchArticles()
  await nextTick()
  setupSortable()
})

// 文章从 0 变为有（或删光后重新新增）时列表容器会重新挂载，需要重建拖拽实例
watch(() => articleStore.articles.length, async () => {
  await nextTick()
  if (sortable && sortable.el !== listRef.value) {
    sortable.destroy()
    sortable = null
  }
  setupSortable()
})

onBeforeUnmount(() => {
  stopAutoScroll()
  removeDragClone()
  sortable?.destroy()
  sortable = null
})

function openArticle(id) {
  // 触摸拖拽刚结束的瞬间浏览器可能补发一次 click，直接忽略
  if (Date.now() < suppressClickUntil) return
  router.push(`/reader/${id}`)
}

async function deleteArticle(id, event) {
  event.stopPropagation()
  if (await confirmDialog('确定要删除这篇文章吗？')) {
    await articleStore.deleteArticle(id)
  }
}

async function exportArticle(articleId, title, event) {
  event.stopPropagation()
  try {
    await wordStore.exportArticleAndDownload(articleId, title)
  } catch (error) {
    await alert('导出失败: ' + error.message)
  }
}

const editingArticle = ref(null)

function startEdit(article, event) {
  event.stopPropagation()
  editingArticle.value = article
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}
</script>

<template>
  <PageLayout>
  <div>
    <div class="mb-3 sm:mb-4 flex items-center justify-between">
      <div>
        <h1 class="text-lg sm:text-xl font-bold text-gray-900 dark:text-neutral-100 mb-1">开始学习</h1>
        <p class="text-gray-600 dark:text-neutral-400 text-xs sm:text-sm">导入英文文章，在语境中学习单词</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          @click="router.push('/new')"
          class="inline-flex items-center gap-2 px-4 sm:px-5 h-10 bg-blue-600 text-white text-sm font-medium rounded-lg shadow hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          title="新建文章"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="hidden sm:inline">新建文章</span>
        </button>
        <button
          @click="router.push('/generate')"
          class="inline-flex items-center gap-1.5 px-3 sm:px-4 h-10 bg-white dark:bg-neutral-800 border border-blue-600 dark:border-blue-500 text-blue-600 dark:text-blue-400 text-sm font-medium rounded-lg hover:bg-blue-50 dark:hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          title="AI生成文章"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 10l-5.714 2.143L13 19l-2.286-6.857L5 10l5.714-2.143L13 1z" />
          </svg>
          <span class="hidden sm:inline">AI生成文章</span>
        </button>
      </div>
    </div>

    <div class="list-card bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-0 sm:p-5">
      <h2 class="px-4 sm:px-0 text-base sm:text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-3 sm:mb-4">最近文章</h2>
      <div v-if="articleStore.loading" class="px-4 sm:px-0 text-center py-8 text-gray-500 dark:text-neutral-400">
        加载中...
      </div>
      <div v-else-if="articleStore.articles.length === 0" class="px-4 sm:px-0 text-center py-8 text-gray-500 dark:text-neutral-400">
        还没有文章，点击右上角新建或 AI 生成
      </div>
      <div v-else ref="listRef" class="article-list">
        <div
          v-for="(article, index) in articleStore.articles"
          :key="article.id"
          :class="{ 'is-dragging': touchDragIndex === index }"
          @click="openArticle(article.id)"
          class="article-item px-4 py-2.5 sm:p-3.5 border-0 sm:border border-gray-200 dark:border-neutral-800 rounded-none sm:rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors"
        >
          <div class="flex justify-between items-start">
            <div
              class="drag-handle shrink-0 self-center -ml-1 mr-1 sm:mr-2 p-2 sm:p-1 text-gray-300 hover:text-gray-400 dark:text-neutral-600 dark:hover:text-neutral-500 cursor-grab active:cursor-grabbing touch-none"
              title="拖动调整顺序"
              @click.stop
              @touchstart="onHandleTouchStart($event, index)"
              @touchmove="onHandleTouchMove"
              @touchend="onHandleTouchEnd"
              @touchcancel="onHandleTouchEnd"
            >
              <GripVertical class="w-4 h-4" />
            </div>
            <div class="flex-1 min-w-0">
              <h3 class="text-sm font-medium text-gray-900 dark:text-neutral-100 truncate">{{ article.title }}</h3>
              <p v-if="article.description" class="text-xs text-gray-600 dark:text-neutral-400 mt-0.5 truncate">{{ article.description }}</p>
              <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                {{ formatDate(article.createdAt) }}
              </p>
            </div>
            <div class="flex items-center gap-1 ml-2">
              <button
                @click="startEdit(article, $event)"
                class="text-gray-400 hover:text-blue-500"
                title="编辑文章"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                @click="exportArticle(article.id, article.title, $event)"
                class="text-gray-400 hover:text-blue-500"
                title="导出文章备份"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              <button
                @click="deleteArticle(article.id, $event)"
                class="text-gray-400 hover:text-red-500"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <EditArticleModal
      v-if="editingArticle"
      :article="editingArticle"
      @close="editingArticle = null"
    />
  </div>
  </PageLayout>
</template>

<style scoped>
.article-drag-ghost {
  opacity: 0.4;
}

/* 移动端拖拽手柄：禁用长按选中/系统菜单与文本选择。
   手指按住手柄稍久会触发系统的「复制/搜索」菜单，手势被系统截走、拖拽中断。 */
.drag-handle {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

/* 桌面端列表项间距（原 space-y-3）。
   写成显式 margin 是为了手机端能单独清零，改用分隔线区隔。 */
.article-item + .article-item {
  margin-top: 0.75rem;
}

/* ============================================================
   手机端：拆掉多层外框
   原来从外到内有「页面留白 px-4 → 卡片边框/圆角/内边距 → 每个列表项
   又是独立圆角边框」，窄屏上层层收窄，看起来一个框套一个框。
   这里把卡片与列表项的外框全部去掉：
   - 卡片用负外边距抵消页面留白，直接铺满屏幕宽度；
   - 列表项变成整行，仅用一条细分隔线区隔，不再是独立的小卡片。
   桌面端保持原有卡片式观感不变。
   ============================================================ */
@media (max-width: 639px) {
  .list-card {
    /* 抵消 PageLayout 的 px-4，让列表真正贴到屏幕两侧 */
    margin-left: -1rem;
    margin-right: -1rem;
    background-color: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .article-item + .article-item {
    margin-top: 0;
    border-top: 1px solid var(--color-gray-200, #e5e7eb);
  }
  html.dark .article-item + .article-item {
    border-top-color: var(--color-neutral-800, #262626);
  }
  /* 拖拽中的原行：内容已由跟手的浮层承担，这里退化成「空位」占位符 */
  .article-item.is-dragging {
    background-color: var(--color-gray-100, #f3f4f6);
    opacity: 0.4;
  }
  html.dark .article-item.is-dragging {
    background-color: var(--color-neutral-800, #262626);
  }
}

/* ============================================================
   拖拽浮层（由 cloneNode 复制原行后挂到 body 上）
   注意：这个元素不在组件的 DOM 子树里，但它带着 scoped 的 data-v 属性，
   所以下面这些带 [data-v] 的规则依然能命中。
   浮层必须有实心底色 + 投影，否则会与下面的列表内容互相透视。
   ============================================================ */
.drag-clone {
  background-color: var(--color-white, #fff);
  box-shadow: 0 10px 24px rgb(0 0 0 / 0.18);
  will-change: transform;
}
html.dark .drag-clone {
  background-color: var(--color-neutral-800, #262626);
  box-shadow: 0 10px 24px rgb(0 0 0 / 0.5);
}
</style>