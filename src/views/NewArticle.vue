<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'

const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()
const newArticleTitle = ref('')
const newArticleDescription = ref('')
const newArticleContent = ref('')
const showImportModal = ref(false)
const importText = ref('')

async function createArticle() {
  if (!newArticleTitle.value.trim() || !newArticleContent.value.trim()) {
    alert('请输入标题和内容')
    return
  }
  const article = await articleStore.createArticle({
    title: newArticleTitle.value.trim(),
    description: newArticleDescription.value.trim(),
    content: newArticleContent.value.trim()
  })
  router.push(`/reader/${article.id}`)
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

async function importArticleJson(event) {
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
</script>

<template>
  <div>
    <div class="mb-8 flex items-center gap-4">
      <button
        @click="router.push('/')"
        class="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-gray-700 dark:hover:text-neutral-200"
        title="返回首页"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
      <h1 class="text-3xl font-bold text-gray-900 dark:text-neutral-100">新建文章</h1>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
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
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">
            描述
            <span class="text-xs text-gray-400 dark:text-neutral-500">（可选）</span>
          </label>
          <textarea
            v-model="newArticleDescription"
            rows="2"
            placeholder="一句话概括文章大致内容..."
            class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
          ></textarea>
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
        <div class="flex flex-col sm:flex-row gap-2 sm:gap-3">
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
            导入备份
            <input type="file" accept=".json" @change="importArticleJson" class="hidden" />
          </label>
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