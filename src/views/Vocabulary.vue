<script setup>
import { ref, onMounted, computed } from 'vue'
import { useWordStore } from '../stores/word'
import { generateArticle } from '../services/ai'
import { useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'

const router = useRouter()
const wordStore = useWordStore()
const articleStore = useArticleStore()

const searchQuery = ref('')
const sortBy = ref('updatedAt')
const selectedWords = ref([])
const expandedArticles = ref(new Set())
const showGenerateModal = ref(false)
const generateTopic = ref('')
const generateStyle = ref('general')
const generating = ref(false)

onMounted(async () => {
  await articleStore.fetchArticles()
  await wordStore.fetchMarkedWords()
})

const allArticles = computed(() => articleStore.articles)

const articlesWithWords = computed(() => {
  const result = []
  for (const article of allArticles.value) {
    const words = wordStore.articleWordsMap[article.id]
    if (words && words.length > 0) {
      result.push(article)
    }
  }

  if (sortBy.value === 'updatedAt') {
    result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  } else if (sortBy.value === 'wordCount') {
    result.sort((a, b) => {
      const aCount = (wordStore.articleWordsMap[a.id] || []).length
      const bCount = (wordStore.articleWordsMap[b.id] || []).length
      return bCount - aCount
    })
  } else if (sortBy.value === 'title') {
    result.sort((a, b) => a.title.localeCompare(b.title))
  }

  return result
})

function getArticleWords(articleId) {
  let words = wordStore.articleWordsMap[articleId] || []

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    words = words.filter(w => w.word.includes(query))
  }

  return words
}

function getWordArticles(wordId) {
  return wordStore.wordArticlesMap[wordId] || []
}

function isArticleExpanded(articleId) {
  return expandedArticles.value.has(articleId)
}

function toggleArticle(articleId) {
  if (expandedArticles.value.has(articleId)) {
    expandedArticles.value.delete(articleId)
  } else {
    expandedArticles.value.add(articleId)
  }
}

function expandAll() {
  for (const article of articlesWithWords.value) {
    const words = getArticleWords(article.id)
    if (words.length > 0) {
      expandedArticles.value.add(article.id)
    }
  }
}

function collapseAll() {
  expandedArticles.value.clear()
}

function toggleSelectWord(id) {
  const index = selectedWords.value.indexOf(id)
  if (index === -1) {
    selectedWords.value.push(id)
  } else {
    selectedWords.value.splice(index, 1)
  }
}

function selectAllVisible() {
  const allVisibleIds = []
  for (const article of articlesWithWords.value) {
    const words = getArticleWords(article.id)
    for (const word of words) {
      allVisibleIds.push(word.id)
    }
  }
  if (selectedWords.value.length === allVisibleIds.length) {
    selectedWords.value = []
  } else {
    selectedWords.value = allVisibleIds
  }
}

async function deleteSelected() {
  if (selectedWords.value.length === 0) return
  if (!confirm(`确定删除 ${selectedWords.value.length} 个单词？`)) return

  for (const id of selectedWords.value) {
    await wordStore.deleteWord(id)
  }
  selectedWords.value = []
}

function exportArticleTxt(articleId, title) {
  const words = getArticleWords(articleId)
  const selectedInArticle = words.filter(w => selectedWords.value.includes(w.id))
  wordStore.exportArticleWordsTxt(articleId, title, selectedInArticle.map(w => w.id))
}

function exportSelectedTxt() {
  if (selectedWords.value.length === 0) return
  wordStore.exportSelectedWordsTxt(selectedWords.value)
}

async function exportWords() {
  const data = await wordStore.exportWords()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `vocabulary_${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function importWords(event) {
  const file = event.target.files[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result)
      await wordStore.importWords(data)
      alert('导入成功')
    } catch (error) {
      alert('导入失败: ' + error.message)
    }
  }
  reader.readAsText(file)
}

async function generateAIArticle() {
  if (selectedWords.value.length === 0) {
    alert('请先选择单词')
    return
  }

  generating.value = true
  try {
    const words = selectedWords.value.map(id => {
      const word = wordStore.markedWords.find(w => w.id === id)
      return word.word
    })

    const content = await generateArticle(words, generateTopic.value, generateStyle.value)
    const title = `AI生成文章 - ${new Date().toLocaleDateString('zh-CN')}`

    const article = await articleStore.createArticle({ title, content })
    showGenerateModal.value = false
    router.push(`/reader/${article.id}`)
  } catch (error) {
    alert('生成失败: ' + error.message)
  } finally {
    generating.value = false
  }
}

function goToArticle(articleId) {
  router.push(`/reader/${articleId}?fromVocab=1`)
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('zh-CN')
}

const totalMarkedWords = computed(() => wordStore.markedWords.length)
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold text-gray-900 dark:text-neutral-100 mb-2">我的词库</h1>
      <p class="text-gray-600 dark:text-neutral-400">
        已标记 {{ totalMarkedWords }} 个单词，分布在 {{ articlesWithWords.length }} 篇文章中
      </p>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6 mb-6">
      <div class="flex flex-col sm:flex-row gap-4 mb-4">
        <div class="flex-1">
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索单词..."
            class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
          />
        </div>
        <div class="flex gap-2">
          <select
            v-model="sortBy"
            class="px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="updatedAt">最近更新</option>
            <option value="wordCount">单词数量</option>
            <option value="title">文章标题</option>
          </select>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          @click="expandAll"
          class="px-3 py-1.5 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          全部展开
        </button>
        <button
          @click="collapseAll"
          class="px-3 py-1.5 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          全部折叠
        </button>
        <button
          @click="selectAllVisible"
          class="px-3 py-1.5 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          {{ selectedWords.length === wordStore.markedWords.length ? '取消全选' : '全选' }}
        </button>
        <button
          @click="deleteSelected"
          :disabled="selectedWords.length === 0"
          class="px-3 py-1.5 text-sm bg-red-100 dark:bg-neutral-800 text-red-700 dark:text-neutral-300 rounded-md hover:bg-red-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          删除选中 ({{ selectedWords.length }})
        </button>
        <button
          @click="showGenerateModal = true"
          :disabled="selectedWords.length === 0"
          class="px-3 py-1.5 text-sm bg-purple-100 dark:bg-neutral-800 text-purple-700 dark:text-neutral-300 rounded-md hover:bg-purple-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          AI 生成文章
        </button>
        <button
          @click="exportSelectedTxt"
          :disabled="selectedWords.length === 0"
          class="px-3 py-1.5 text-sm bg-orange-100 dark:bg-neutral-800 text-orange-700 dark:text-neutral-300 rounded-md hover:bg-orange-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          导出选中TXT
        </button>
        <div class="flex-1"></div>
        <button
          @click="exportWords"
          class="px-3 py-1.5 text-sm bg-blue-100 dark:bg-neutral-800 text-blue-700 dark:text-neutral-300 rounded-md hover:bg-blue-200 dark:hover:bg-neutral-700"
        >
          导出
        </button>
        <label class="px-3 py-1.5 text-sm bg-green-100 dark:bg-neutral-800 text-green-700 dark:text-neutral-300 rounded-md hover:bg-green-200 dark:hover:bg-neutral-700 cursor-pointer">
          导入
          <input type="file" accept=".json" @change="importWords" class="hidden" />
        </label>
      </div>
    </div>

    <div v-if="articlesWithWords.length === 0" class="text-center py-12 text-gray-500 dark:text-neutral-400">
      还没有标记的单词
    </div>

    <div v-else class="space-y-4">
      <div
        v-for="article in articlesWithWords"
        :key="article.id"
        class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 overflow-hidden"
      >
        <div
          @click="toggleArticle(article.id)"
          class="px-6 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors flex items-center justify-between"
        >
          <div class="flex items-center gap-3 min-w-0">
            <svg
              :class="[
                'w-5 h-5 text-gray-400 transition-transform flex-shrink-0',
                isArticleExpanded(article.id) ? 'rotate-90' : ''
              ]"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
            </svg>
            <h3 class="font-semibold text-gray-900 dark:text-neutral-100 truncate">{{ article.title }}</h3>
          </div>
          <div class="flex items-center gap-3 flex-shrink-0">
            <span class="text-sm text-gray-500 dark:text-neutral-400">
              {{ getArticleWords(article.id).length }} 个单词
            </span>
            <span class="text-xs text-gray-400 dark:text-neutral-500">
              {{ formatDate(article.updatedAt) }}
            </span>
            <button
              @click.stop="goToArticle(article.id)"
              class="px-2 py-1 text-xs bg-blue-50 dark:bg-neutral-800 text-blue-600 dark:text-neutral-300 rounded hover:bg-blue-100 dark:hover:bg-neutral-700"
            >
              查看原文
            </button>
            <button
              @click.stop="exportArticleTxt(article.id, article.title)"
              class="px-2 py-1 text-xs bg-orange-50 dark:bg-neutral-800 text-orange-600 dark:text-neutral-300 rounded hover:bg-orange-100 dark:hover:bg-neutral-700"
              title="导出该文章单词为TXT"
            >
              导出TXT
            </button>
          </div>
        </div>

        <div v-if="isArticleExpanded(article.id)" class="px-6 pb-4 border-t border-gray-100 dark:border-neutral-800">
          <div v-if="getArticleWords(article.id).length === 0" class="py-4 text-sm text-gray-400 dark:text-neutral-500 text-center">
            该文章中没有匹配的单词
          </div>
          <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
            <div
              v-for="word in getArticleWords(article.id)"
              :key="word.id"
              @click="toggleSelectWord(word.id)"
              :class="[
                'rounded-lg border p-3 cursor-pointer transition-all',
                selectedWords.includes(word.id)
                  ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50 dark:border-neutral-500 dark:ring-neutral-600 dark:bg-neutral-700/60'
                  : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600 bg-white dark:bg-neutral-800'
              ]"
            >
              <div class="flex items-start justify-between">
                <div class="min-w-0">
                  <h4 class="font-semibold text-gray-900 dark:text-neutral-100">{{ word.word }}</h4>
                  <p v-if="word.phonetic" class="text-xs text-gray-500 dark:text-neutral-400">{{ word.phonetic }}</p>
                </div>
                <div
                  :class="[
                    'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0',
                    selectedWords.includes(word.id)
                      ? 'bg-blue-500 border-blue-500'
                      : 'border-gray-300 dark:border-neutral-600'
                  ]"
                >
                  <svg
                    v-if="selectedWords.includes(word.id)"
                    class="w-3 h-3 text-white"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                </div>
              </div>
              <p v-if="word.definitions?.length" class="text-xs text-gray-600 dark:text-neutral-400 mt-1.5 line-clamp-2">
                {{ word.definitions[0].meaning }}
              </p>
              <div v-if="getWordArticles(word.id).length > 1" class="mt-2 flex flex-wrap gap-1">
                <span
                  v-for="a in getWordArticles(word.id)"
                  :key="a.id"
                  :class="[
                    'inline-flex items-center px-1.5 py-0.5 text-xs rounded cursor-pointer',
                    a.id === article.id
                      ? 'bg-gray-100 dark:bg-neutral-700 text-gray-500 dark:text-neutral-400'
                      : 'bg-blue-50 dark:bg-neutral-800 text-blue-600 dark:text-neutral-300 hover:bg-blue-100 dark:hover:bg-neutral-700'
                  ]"
                  @click.stop="goToArticle(a.id)"
                  :title="a.title"
                >
                  {{ a.id === article.id ? '当前' : (a.title.length > 8 ? a.title.slice(0, 8) + '...' : a.title) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="showGenerateModal"
      class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    >
      <div class="bg-white dark:bg-neutral-900 rounded-lg p-6 max-w-md w-full mx-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">AI 生成文章</h3>
        <p class="text-sm text-gray-600 dark:text-neutral-400 mb-4">
          已选择 {{ selectedWords.length }} 个单词
        </p>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章主题（可选）</label>
            <input
              v-model="generateTopic"
              type="text"
              placeholder="例如：科技、旅行、美食..."
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章风格</label>
            <select
              v-model="generateStyle"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="general">通用</option>
              <option value="story">故事</option>
              <option value="news">新闻</option>
              <option value="academic">学术</option>
              <option value="dialogue">对话</option>
            </select>
          </div>
          <div class="flex space-x-3">
            <button
              @click="generateAIArticle"
              :disabled="generating"
              class="flex-1 bg-purple-600 text-white py-2 px-4 rounded-md hover:bg-purple-700 disabled:opacity-50"
            >
              {{ generating ? '生成中...' : '生成' }}
            </button>
            <button
              @click="showGenerateModal = false"
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
