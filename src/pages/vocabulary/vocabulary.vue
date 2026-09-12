<script setup>
import { ref, onMounted, computed } from 'vue'
import { useWordStore } from '../../stores/word'
import { useRouter, usePageRoute } from '../../composables/routerShim'
import PageLayout from '../../components/Common/PageLayout.vue'
import { useArticleStore } from '../../stores/article'
import { speak } from '../../services/tts'
import { confirmDialog } from '../../services/dialog'
import { toast } from '../../services/toast'
import { errorText } from '../../services/errors'
import { dbReady } from '../../services/db'

usePageRoute()
const router = useRouter()
const wordStore = useWordStore()
const articleStore = useArticleStore()

const sortBy = ref('updatedAt')
const selectedWords = ref([])
const expandedArticles = ref(new Set())
// 页面级加载错误（db 未就绪 / 文章列表读取失败）；词库自身的失败原因由 store 记录
const pageError = ref('')
const loadError = computed(() => pageError.value || wordStore.loadError)

async function loadVocabulary() {
  pageError.value = ''
  // 等 db schema 就绪再读库：迁移后 ensureSchema 不再是顶层 await（uni 构建不支持），
  // 页面挂载可能早于 dbReady，直接读库存在时序竞态
  try {
    await dbReady
  } catch (e) {
    console.error('[Vocabulary] 数据库未就绪:', e)
    pageError.value = errorText(e, '本地数据库未就绪，请刷新后重试')
    return
  }
  // App 启动时已通过 wordStore.fetchMarkedWords() 完成一次全量加载，
  // 复用缓存避免每次进入词库重复读全量数据（数据变更时会自动失效重新加载）。
  // 缓存标记已 loaded 但数据为空时强刷一次：覆盖「启动加载与同步写入交叠」的窗口
  if (!wordStore.loaded || wordStore.markedWords.length === 0) {
    await wordStore.fetchMarkedWords(true)
  }
  // 文章列表通常已在首页加载过；为空时才补充加载，避免重复读库
  if (articleStore.articles.length === 0) {
    try {
      await articleStore.fetchArticles()
    } catch (e) {
      pageError.value = errorText(e, '文章列表加载失败，请重试')
    }
  }
}

onMounted(() => {
  loadVocabulary()
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

// 当前可勾选的全部单词 id（与 selectAllVisible 的作用集合一致）。
// 「全选/取消全选」的文案判据必须与行为判据同源：此前文案比的是去重后的
// markedWords.length，行为比的是逐文章记录数，两者在多文章重复单词时不一致，
// 会出现「按钮写全选、点击却清空」的矛盾。
const allVisibleWordIds = computed(() => {
  const ids = []
  for (const article of articlesWithWords.value) {
    for (const word of getArticleWords(article.id)) {
      ids.push(word.id)
    }
  }
  return ids
})

const isAllSelected = computed(() =>
  allVisibleWordIds.value.length > 0 && selectedWords.value.length === allVisibleWordIds.value.length
)

function selectAllVisible() {
  const allVisibleIds = allVisibleWordIds.value
  if (selectedWords.value.length === allVisibleIds.length) {
    selectedWords.value = []
  } else {
    selectedWords.value = [...allVisibleIds]
  }
}

// 批量删除执行中标记：避免重复点击导致并发删除
const deleting = ref(false)

async function deleteSelected() {
  const count = selectedWords.value.length
  if (count === 0 || deleting.value) return
  // 删除按「拼写」生效、且跨文章：同样拼写在其它文章中标记的记录、释义与语境翻译
  // 会一并删除，确认文案必须说明影响范围（原文案只报个数，会误导用户）
  if (!await confirmDialog(
    `确定删除选中的 ${count} 个单词吗？\n\n` +
    '注意：删除按单词拼写生效，该单词在其它文章中标记的记录、释义与语境翻译也会一并删除，且无法恢复。'
  )) return

  deleting.value = true
  try {
    await wordStore.deleteWordsByIds(selectedWords.value)
    selectedWords.value = []
    await toast('已删除选中单词')
  } catch (e) {
    await toast(errorText(e, '删除失败，请重试'), 'error')
  } finally {
    deleting.value = false
  }
}

async function exportArticleTxt(articleId, title) {
  const words = getArticleWords(articleId)
  const selectedInArticle = words.filter(w => selectedWords.value.includes(w.id))
  try {
    wordStore.exportArticleWordsTxt(articleId, title, selectedInArticle.map(w => w.id))
    await toast('已导出该文章单词')
  } catch (e) {
    await toast(errorText(e, '导出失败，请重试'), 'error')
  }
}

async function exportSelectedTxt() {
  if (selectedWords.value.length === 0) return
  try {
    await wordStore.exportSelectedWordsTxt(selectedWords.value)
    await toast('已导出选中单词')
  } catch (e) {
    await toast(errorText(e, '导出失败，请重试'), 'error')
  }
}

async function goToGenerate() {
  if (selectedWords.value.length === 0) return
  // 按 id 全集解析拼写：勾选来源是 articleWordsMap（每篇文章一条记录），
  // 用去重后的 markedWords 回查会丢掉较旧记录的 id，导致静默丢词
  const words = await wordStore.getWordsByIds(selectedWords.value)
  const spellings = [...new Set(words.map(w => w.word))]
  if (spellings.length === 0) {
    await toast('选中的单词已不在词库中，请重新选择', 'error')
    return
  }
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
  <PageLayout>
  <div>
    <div class="mb-4">
      <h1 class="text-xl font-bold text-gray-900 dark:text-neutral-100 mb-1.5">我的词库</h1>
      <p class="text-gray-600 dark:text-neutral-400 text-sm">
        已标记 {{ totalMarkedWords }} 个单词，分布在 {{ articlesWithWords.length }} 篇文章中
      </p>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-4 mb-5">
      <div class="flex flex-wrap items-center gap-2">
        <button
          @click="expandAll"
          class="px-3 py-1 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          全部展开
        </button>
        <button
          @click="collapseAll"
          class="px-3 py-1 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          全部折叠
        </button>
        <button
          @click="selectAllVisible"
          class="px-3 py-1 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          {{ isAllSelected ? '取消全选' : '全选' }}
        </button>
        <button
          @click="deleteSelected"
          :disabled="selectedWords.length === 0 || deleting"
          class="px-3 py-1 text-sm bg-red-100! dark:bg-neutral-800! text-red-700! dark:text-neutral-300! rounded-md hover:bg-red-200! dark:hover:bg-neutral-700! disabled:opacity-50 disabled:cursor-not-allowed"
        >
          删除选中 ({{ selectedWords.length }})
        </button>
        <button
          @click="goToGenerate"
          :disabled="selectedWords.length === 0"
          class="px-3 py-1 text-sm bg-purple-100! dark:bg-neutral-800! text-purple-700! dark:text-neutral-300! rounded-md hover:bg-purple-200! dark:hover:bg-neutral-700! disabled:opacity-50 disabled:cursor-not-allowed"
        >
          AI 生成文章
        </button>
        <button
          @click="exportSelectedTxt"
          :disabled="selectedWords.length === 0"
          class="px-3 py-1 text-sm bg-orange-100! dark:bg-neutral-800! text-orange-700! dark:text-neutral-300! rounded-md hover:bg-orange-200! dark:hover:bg-neutral-700! disabled:opacity-50 disabled:cursor-not-allowed"
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

    <!-- 三态：加载中 / 加载失败（可重试）/ 空数据，避免把失败显示成「还没有标记的单词」 -->
    <div v-if="wordStore.loading" class="text-center py-12 text-gray-500 dark:text-neutral-400">
      加载中...
    </div>
    <div v-else-if="loadError" class="text-center py-12">
      <p class="text-sm text-red-500 dark:text-red-400">{{ loadError }}</p>
      <button
        @click="loadVocabulary"
        class="mt-3 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
      >
        重试
      </button>
    </div>
    <div v-else-if="articlesWithWords.length === 0" class="text-center py-12 text-gray-500 dark:text-neutral-400">
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
          class="px-4 sm:px-5 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition-colors"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-2.5 min-w-0 flex-1">
              <svg
                :class="[
                  'w-5 h-5 mt-0.5 text-gray-400 transition-transform flex-shrink-0',
                  isArticleExpanded(article.id) ? 'rotate-90' : ''
                ]"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
              </svg>
              <div class="min-w-0 flex-1">
                <h3 class="font-semibold text-gray-900 dark:text-neutral-100 leading-snug break-words line-clamp-2">{{ article.title }}</h3>
                <div class="flex items-center gap-3 mt-1 text-sm text-gray-500 dark:text-neutral-400">
                  <span>{{ getArticleWords(article.id).length }} 个单词</span>
                  <span class="text-xs text-gray-400 dark:text-neutral-500">{{ formatDate(article.updatedAt) }}</span>
                </div>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                @click.stop="goToArticle(article.id)"
                class="px-2.5 py-1 text-xs bg-blue-50 dark:bg-neutral-800 text-blue-600 dark:text-neutral-300 rounded hover:bg-blue-100 dark:hover:bg-neutral-700"
              >
                管理模式
              </button>
              <button
                @click.stop="exportArticleTxt(article.id, article.title)"
                class="px-2.5 py-1 text-xs bg-orange-50 dark:bg-neutral-800 text-orange-600 dark:text-neutral-300 rounded hover:bg-orange-100 dark:hover:bg-neutral-700"
                title="导出该文章单词为TXT"
              >
                导出TXT
              </button>
            </div>
          </div>
        </div>

        <div v-if="isArticleExpanded(article.id)" class="px-4 sm:px-5 pb-3 border-t border-gray-100 dark:border-neutral-800">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
            <!-- 单词卡可点选：补 checkbox 语义与键盘触发，否则键盘用户无法勾选单词 -->
            <div
              v-for="word in getArticleWords(article.id)"
              :key="word.id"
              role="checkbox"
              tabindex="0"
              :aria-checked="selectedWords.includes(word.id)"
              :aria-label="word.word"
              @click="toggleSelectWord(word.id)"
              @keydown.enter.prevent="toggleSelectWord(word.id)"
              @keydown.space.prevent="toggleSelectWord(word.id)"
              :class="[
                'rounded-lg border p-3 cursor-pointer transition-all',
                selectedWords.includes(word.id)
                  ? 'border-blue-500 ring-2 ring-blue-200 bg-blue-50 dark:border-neutral-500 dark:ring-neutral-600 dark:bg-neutral-700/60'
                  : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600 bg-white dark:bg-neutral-800'
              ]"
            >
              <div class="flex items-start justify-between">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <h4 class="font-semibold text-gray-900 dark:text-neutral-100">{{ word.word }}</h4>
                    <button
                      @click.stop="speak(word.word)"
                      class="flex-shrink-0 p-1 -m-1 text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                      title="播放发音"
                      aria-label="播放发音"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                      </svg>
                    </button>
                  </div>
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
  </PageLayout>
</template>
