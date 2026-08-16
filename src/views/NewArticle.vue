<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'
import ImageImportModal from '../components/AI/ImageImportModal.vue'

const router = useRouter()
const articleStore = useArticleStore()
const newArticleTitle = ref('')
const newArticleDescription = ref('')
const newArticleContent = ref('')
const showImageModal = ref(false)

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

// 图片识别完成：回填表单
function handleExtracted(payload) {
  if (payload.title) newArticleTitle.value = payload.title
  if (payload.description) newArticleDescription.value = payload.description
  if (payload.content) newArticleContent.value = payload.content
}
</script>

<template>
  <div class="max-w-3xl mx-auto">
    <div class="mb-6 flex items-center gap-3">
      <button
        @click="router.push('/')"
        class="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-gray-700 dark:hover:text-neutral-200 transition-colors"
        title="返回首页"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
      <h1 class="text-xl font-bold text-gray-900 dark:text-neutral-100">新建文章</h1>
      <button
        @click="createArticle"
        class="ml-auto bg-blue-600 text-white px-6 py-2 rounded-md font-medium hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-black transition-colors"
      >
        开始学习
      </button>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-xl shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
      <div class="space-y-5">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">标题</label>
          <input
            v-model="newArticleTitle"
            type="text"
            placeholder="输入文章标题"
            class="w-full px-3 py-2.5 text-lg font-semibold border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400 dark:placeholder-neutral-600 placeholder:font-normal"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">
            描述
            <span class="text-xs font-normal text-gray-400 dark:text-neutral-500">（可选）</span>
          </label>
          <textarea
            v-model="newArticleDescription"
            rows="2"
            placeholder="一句话概括文章大致内容..."
            class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400 dark:placeholder-neutral-600"
          ></textarea>
        </div>

        <div>
          <div class="flex items-center justify-between mb-2">
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300">内容</label>
            <button
              @click="showImageModal = true"
              class="flex items-center gap-1.5 text-xs text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 transition-colors"
              title="导入图片，AI 识别文章内容"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              从图片识别
            </button>
          </div>
          <textarea
            v-model="newArticleContent"
            rows="12"
            placeholder="粘贴英文文章内容..."
            class="w-full px-3 py-2 leading-relaxed border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-950 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-400 dark:placeholder-neutral-600"
          ></textarea>
        </div>

      </div>
    </div>

    <ImageImportModal :open="showImageModal" @close="showImageModal = false" @extracted="handleExtracted" />
  </div>
</template>
