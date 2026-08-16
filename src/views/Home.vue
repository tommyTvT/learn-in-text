<script setup>
import { onMounted, onBeforeUnmount, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Sortable from 'sortablejs'
import { GripVertical } from 'lucide-vue-next'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'
import EditArticleModal from '../components/Article/EditArticleModal.vue'

const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()

const listRef = ref(null)
let sortable = null

function setupSortable() {
  if (sortable || !listRef.value) return
  sortable = new Sortable(listRef.value, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'article-drag-ghost',
    // 移动端按住手柄稍候才启动拖拽，避免与列表滚动冲突
    delayOnTouchOnly: true,
    delay: 150,
    onEnd(evt) {
      if (evt.oldIndex == null || evt.newIndex == null || evt.oldIndex === evt.newIndex) return
      articleStore.moveArticle(evt.oldIndex, evt.newIndex)
    }
  })
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
  sortable?.destroy()
  sortable = null
})

function openArticle(id) {
  router.push(`/reader/${id}`)
}

async function deleteArticle(id, event) {
  event.stopPropagation()
  if (confirm('确定要删除这篇文章吗？')) {
    await articleStore.deleteArticle(id)
  }
}

async function exportArticle(articleId, title, event) {
  event.stopPropagation()
  try {
    await wordStore.exportArticleAndDownload(articleId, title)
  } catch (error) {
    alert('导出失败: ' + error.message)
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
  <div>
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-gray-900 dark:text-neutral-100 mb-1.5">开始学习</h1>
        <p class="text-gray-600 dark:text-neutral-400 text-sm">导入英文文章，在语境中学习单词</p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          @click="router.push('/new')"
          class="inline-flex items-center gap-2 px-5 h-10 bg-blue-600 text-white text-sm font-medium rounded-lg shadow hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          title="新建文章"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="hidden sm:inline">新建文章</span>
        </button>
        <button
          @click="router.push('/generate')"
          class="inline-flex items-center gap-1.5 px-4 h-10 bg-white dark:bg-neutral-800 border border-blue-600 dark:border-blue-500 text-blue-600 dark:text-blue-400 text-sm font-medium rounded-lg hover:bg-blue-50 dark:hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          title="AI生成文章"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 10l-5.714 2.143L13 19l-2.286-6.857L5 10l5.714-2.143L13 1z" />
          </svg>
          <span class="hidden sm:inline">AI生成文章</span>
        </button>
      </div>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-5">
      <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">最近文章</h2>
      <div v-if="articleStore.loading" class="text-center py-8 text-gray-500 dark:text-neutral-400">
        加载中...
      </div>
      <div v-else-if="articleStore.articles.length === 0" class="text-center py-8 text-gray-500 dark:text-neutral-400">
        还没有文章，点击右上角新建或 AI 生成
      </div>
      <div v-else ref="listRef" class="space-y-3">
        <div
          v-for="article in articleStore.articles"
          :key="article.id"
          @click="openArticle(article.id)"
          class="p-3.5 border border-gray-200 dark:border-neutral-800 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors"
        >
          <div class="flex justify-between items-start">
            <div
              class="drag-handle shrink-0 self-center -ml-1 mr-2 p-1 text-gray-300 hover:text-gray-400 dark:text-neutral-600 dark:hover:text-neutral-500 cursor-grab active:cursor-grabbing touch-none"
              title="拖动调整顺序"
              @click.stop
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
</template>

<style scoped>
.article-drag-ghost {
  opacity: 0.4;
}
</style>