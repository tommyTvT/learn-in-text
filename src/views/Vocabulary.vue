<script setup>
import { ref, onMounted, computed } from 'vue'
import { useWordStore } from '../stores/word'
import { useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'

const router = useRouter()
const wordStore = useWordStore()
const articleStore = useArticleStore()

const sortBy = ref('updatedAt')
const selectedWords = ref([])
const expandedArticles = ref(new Set())

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
  return wordStore.articleWordsMap[articleId] || []
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

function goToGenerate() {
  if (selectedWords.value.length === 0) return
  const spellings = selectedWords.value.map(id => {
    const word = wordStore.markedWords.find(w => w.id === id)
    return word ? word.word : ''
  }).filter(Boolean)
  router.push({ path: '/generate', query: { words: spellings.join(',') } })
}

function goToArticle(articleId) {
  router.push(`/reader/${articleId}?mode=view`)
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
      <div class="flex flex-wrap items-center gap-2">
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
          @click="goToGenerate"
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
          class="px-4 sm:px-6 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors flex items-center justify-between gap-2 flex-wrap"
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
          <div class="flex items-center gap-3 flex-shrink-0 flex-wrap justify-end">
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
              管理模式
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

        <div v-if="isArticleExpanded(article.id)" class="px-4 sm:px-6 pb-4 border-t border-gray-100 dark:border-neutral-800">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
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
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
