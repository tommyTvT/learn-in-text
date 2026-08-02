<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'

const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()
const newArticleTitle = ref('')
const newArticleContent = ref('')
const showImportModal = ref(false)
const importText = ref('')

onMounted(() => {
  articleStore.fetchArticles()
})

async function createArticle() {
  if (!newArticleTitle.value.trim() || !newArticleContent.value.trim()) {
    alert('请输入标题和内容')
    return
  }
  const article = await articleStore.createArticle({
    title: newArticleTitle.value.trim(),
    content: newArticleContent.value.trim()
  })
  newArticleTitle.value = ''
  newArticleContent.value = ''
  router.push(`/reader/${article.id}`)
}

function openArticle(id) {
  router.push(`/reader/${id}`)
}

async function deleteArticle(id, event) {
  event.stopPropagation()
  if (confirm('确定要删除这篇文章吗？')) {
    await articleStore.deleteArticle(id)
  }
}

function handleFileUpload(event) {
  const file = event.target.files[0]
  if (file) {
    const reader = new FileReader()
    reader.onload = (e) => {
      importText.value = e.target.result
    }
    reader.readAsText(file)
  }
}

function importArticle() {
  if (!importText.value.trim()) {
    alert('请输入或上传文章内容')
    return
  }
  const lines = importText.value.trim().split('\n')
  const title = lines[0].substring(0, 50) || '导入的文章'
  const content = importText.value.trim()
  
  newArticleTitle.value = title
  newArticleContent.value = content
  showImportModal.value = false
  importText.value = ''
}

async function exportArticle(articleId, title, event) {
  event.stopPropagation()
  try {
    await wordStore.exportArticleAndDownload(articleId, title)
  } catch (error) {
    alert('导出失败: ' + error.message)
  }
}

function importArticleJson(event) {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result)
      const articleId = await wordStore.importArticle(data)
      alert('导入成功')
      router.push(`/reader/${articleId}`)
    } catch (error) {
      alert('导入失败: ' + error.message)
    }
  }
  reader.readAsText(file)
  event.target.value = ''
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
    <div class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900 dark:text-neutral-100 mb-2">开始学习</h1>
      <p class="text-gray-600 dark:text-neutral-400">导入英文文章，在语境中学习单词</p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">新建文章</h2>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">标题</label>
            <input
              v-model="newArticleTitle"
              type="text"
              placeholder="输入文章标题"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">内容</label>
            <textarea
              v-model="newArticleContent"
              rows="10"
              placeholder="粘贴英文文章内容..."
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            ></textarea>
          </div>
            <div class="flex space-x-3">
              <button
                @click="createArticle"
                class="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                开始学习
              </button>
              <button
                @click="showImportModal = true"
                class="flex-1 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 py-2 px-4 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                导入文件
              </button>
              <label class="flex-1 bg-green-100 dark:bg-neutral-800 text-green-700 dark:text-neutral-300 py-2 px-4 rounded-md hover:bg-green-200 dark:hover:bg-neutral-700 text-center cursor-pointer">
                导入文章备份
                <input type="file" accept=".json" @change="importArticleJson" class="hidden" />
              </label>
            </div>
        </div>
      </div>

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-xl font-semibold text-gray-900 dark:text-neutral-100 mb-4">最近文章</h2>
        <div v-if="articleStore.loading" class="text-center py-8 text-gray-500 dark:text-neutral-400">
          加载中...
        </div>
        <div v-else-if="articleStore.articles.length === 0" class="text-center py-8 text-gray-500 dark:text-neutral-400">
          还没有文章，开始创建吧
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="article in articleStore.articles"
            :key="article.id"
            @click="openArticle(article.id)"
            class="p-4 border border-gray-200 dark:border-neutral-800 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors"
          >
            <div class="flex justify-between items-start">
              <div class="flex-1 min-w-0">
                <h3 class="text-sm font-medium text-gray-900 dark:text-neutral-100 truncate">{{ article.title }}</h3>
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  {{ formatDate(article.createdAt) }}
                </p>
              </div>
              <div class="flex items-center gap-1 ml-2">
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
    </div>

    <div
      v-if="showImportModal"
      class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    >
      <div class="bg-white dark:bg-neutral-900 rounded-lg p-6 max-w-lg w-full mx-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">导入文章</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">上传文件</label>
            <input
              type="file"
              accept=".txt"
              @change="handleFileUpload"
              class="w-full text-sm text-gray-500 dark:text-neutral-400 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 dark:file:bg-neutral-800 file:text-blue-700 dark:file:text-neutral-300 hover:file:bg-blue-100 dark:hover:file:bg-neutral-700"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">或粘贴内容</label>
            <textarea
              v-model="importText"
              rows="8"
              placeholder="粘贴英文文章内容..."
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            ></textarea>
          </div>
          <div class="flex space-x-3">
            <button
              @click="importArticle"
              class="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700"
            >
              导入
            </button>
            <button
              @click="showImportModal = false"
              class="flex-1 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 py-2 px-4 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
