<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { generateArticle, generateArticleTitle } from '../services/ai'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'

const route = useRoute()
const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()

const mode = ref('essay')
const words = ref([])
const essayType = ref('small')
const format = ref('general')
const articleStyle = ref('general')
const wordCount = ref(80)
const customDescription = ref('')
const sourceArticle = ref('')
const fileInput = ref(null)

const essayWordCountPresets = [50, 80, 120, 150, 200]
const articleWordCountPresets = [150, 300, 500, 800]

const wordCountPresets = computed(() => (mode.value === 'essay' ? essayWordCountPresets : articleWordCountPresets))
const wordCountMin = computed(() => (mode.value === 'essay' ? 20 : 50))
const wordCountMax = computed(() => (mode.value === 'essay' ? 600 : 2000))

const generating = ref(false)
const generatingTitle = ref(false)
const error = ref('')
const result = ref(null)
const resultTitle = ref('')

onMounted(async () => {
  await wordStore.fetchMarkedWords()
  const queryWords = route.query.words
  if (queryWords) {
    words.value = String(queryWords)
      .split(',')
      .map(w => w.trim())
      .filter(Boolean)
  }
})

function switchMode(newMode) {
  mode.value = newMode
  if (newMode === 'essay') {
    applyEssayTypeDefaults()
  } else {
    wordCount.value = 300
  }
}

function applyEssayTypeDefaults() {
  if (essayType.value === 'small') {
    wordCount.value = 80
  } else {
    wordCount.value = 150
  }
}

function onEssayTypeChange() {
  if (mode.value === 'essay') applyEssayTypeDefaults()
}

const essayTypeLabel = computed(() => ({ small: '高中小作文（约80词，简洁应用文）', long: '高中大作文（读后续写风格，约150词）' }[essayType.value]))
const formatLabel = computed(() => ({
  general: '普通作文',
  recommendation: '推荐信',
  thankYou: '感谢信',
  invitation: '邀请信',
  suggestion: '建议信',
  application: '申请信',
  apology: '道歉信',
  complaint: '投诉信'
}[format.value]))
const articleStyleLabel = computed(() => ({ general: '通用', story: '故事', news: '新闻', academic: '学术', dialogue: '对话' }[articleStyle.value]))

const resultWordCount = computed(() => {
  if (!result.value) return 0
  return (result.value.match(/[a-zA-Z']+/g) || []).length
})

function removeWord(index) {
  words.value.splice(index, 1)
}

function clearWords() {
  words.value = []
}

function onFileUpload(event) {
  const file = event.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    sourceArticle.value = String(reader.result || '').trim()
  }
  reader.readAsText(file)
  event.target.value = ''
}

async function generate() {
  if (words.value.length === 0) {
    alert('请先选择要包含的单词')
    return
  }
  if (mode.value === 'essay' && essayType.value === 'long') {
    if (!sourceArticle.value.trim()) {
      alert('读后续写必须提供原文材料（粘贴或上传 .txt）')
      return
    }
  }
  error.value = ''
  generating.value = true
  try {
    const content = await generateArticle(words.value, {
      mode: mode.value,
      essayType: essayType.value,
      format: format.value,
      style: articleStyle.value,
      wordCount: wordCount.value,
      customDescription: customDescription.value.trim(),
      sourceArticle: sourceArticle.value.trim()
    })
    result.value = content.trim()
    resultTitle.value = `AI生成文章 - ${new Date().toLocaleDateString('zh-CN')}`
    autoGenerateTitle()
  } catch (e) {
    error.value = e.message
  } finally {
    generating.value = false
  }
}

async function autoGenerateTitle() {
  if (!result.value) return
  generatingTitle.value = true
  try {
    const title = await generateArticleTitle(result.value, {
      mode: mode.value,
      essayType: essayType.value,
      style: articleStyle.value
    })
    if (title) {
      resultTitle.value = title
    }
  } catch (e) {
    console.error('AI标题生成失败:', e.message)
  } finally {
    generatingTitle.value = false
  }
}

async function regenerateTitle() {
  if (generatingTitle.value) return
  await autoGenerateTitle()
}

async function saveArticle() {
  if (!result.value) return
  try {
    const article = await articleStore.createArticle({
      title: resultTitle.value.trim() || 'AI生成文章',
      content: result.value
    })
    router.push(`/reader/${article.id}`)
  } catch (e) {
    alert('保存失败: ' + e.message)
  }
}
</script>

<template>
  <div>
    <div class="mb-8 flex items-center gap-4">
      <button
        @click="router.push('/vocabulary')"
        class="p-2 rounded-md text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 hover:text-gray-700 dark:hover:text-neutral-200"
        title="返回词库"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
      <div>
        <h1 class="text-3xl font-bold text-gray-900 dark:text-neutral-100">AI 生成文章</h1>
        <p class="text-gray-600 dark:text-neutral-400 mt-1">基于已选单词，定制一篇专属英语阅读文章</p>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">生成参数</h2>
        <div class="grid grid-cols-2 gap-1 p-1 bg-gray-100 dark:bg-neutral-800 rounded-lg mb-5">
          <button
            @click="switchMode('essay')"
            :class="[
              'px-3 py-2 text-sm font-medium rounded-md transition-colors',
              mode === 'essay'
                ? 'bg-white dark:bg-neutral-700 text-purple-700 dark:text-purple-300 shadow-sm'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
            ]"
          >
            高中作文
          </button>
          <button
            @click="switchMode('article')"
            :class="[
              'px-3 py-2 text-sm font-medium rounded-md transition-colors',
              mode === 'article'
                ? 'bg-white dark:bg-neutral-700 text-blue-700 dark:text-blue-300 shadow-sm'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
            ]"
          >
            普通文章
          </button>
        </div>
        <div class="space-y-5">
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300">包含单词</label>
              <button
                v-if="words.length > 0"
                @click="clearWords"
                class="text-xs text-gray-400 dark:text-neutral-500 hover:text-red-500"
              >
                清空
              </button>
            </div>
            <div
              v-if="words.length === 0"
              class="px-3 py-2.5 rounded-md bg-gray-50 dark:bg-neutral-800 border border-dashed border-gray-300 dark:border-neutral-700 text-sm text-gray-500 dark:text-neutral-400"
            >
              未选择单词，请先到<a @click="router.push('/vocabulary')" class="text-blue-600 dark:text-blue-400 hover:underline mx-0.5">词库页</a>勾选单词再进入
            </div>
            <div v-else class="flex flex-wrap gap-2">
              <span
                v-for="(word, index) in words"
                :key="index"
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 dark:bg-neutral-800 text-sm text-blue-700 dark:text-neutral-200"
              >
                {{ word }}
                <button @click="removeWord(index)" class="text-blue-400 dark:text-neutral-500 hover:text-red-500" title="移除">
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            </div>
          </div>

          <template v-if="mode === 'essay'">
            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">作文类型</label>
              <select
                v-model="essayType"
                @change="onEssayTypeChange"
                class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="small">高中小作文（约80词）</option>
                <option value="long">高中大作文（读后续写，约150词）</option>
              </select>
            </div>
            <div v-if="essayType === 'small'">
              <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">写作格式</label>
              <select
                v-model="format"
                class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="general">普通作文（无特定格式）</option>
                <option value="recommendation">推荐信</option>
                <option value="thankYou">感谢信</option>
                <option value="invitation">邀请信</option>
                <option value="suggestion">建议信</option>
                <option value="application">申请信</option>
                <option value="apology">道歉信</option>
                <option value="complaint">投诉信</option>
              </select>
            </div>
          </template>
          <template v-if="mode === 'essay'">
            <div v-if="essayType === 'long'">
              <div class="flex items-center justify-between mb-1">
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300">
                  原文材料
                  <span class="text-xs text-red-500">（必填）</span>
                </label>
                <button
                  @click="fileInput && fileInput.click()"
                  class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  上传 .txt
                </button>
              </div>
              <input ref="fileInput" type="file" accept=".txt,.md" class="hidden" @change="onFileUpload" />
              <textarea
                v-model="sourceArticle"
                rows="6"
                placeholder="粘贴完整题目说明与阅读材料（含段落开头句），或点击右上角上传 .txt 文件"
                class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 placeholder-gray-400 dark:placeholder-neutral-500"
              ></textarea>
            </div>
          </template>
          <div v-else>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章风格</label>
            <select
              v-model="articleStyle"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="general">通用</option>
              <option value="story">故事</option>
              <option value="news">新闻</option>
              <option value="academic">学术</option>
              <option value="dialogue">对话</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章字数</label>
            <div class="flex flex-wrap gap-2 mb-2">
              <button
                v-for="preset in wordCountPresets"
                :key="preset"
                @click="wordCount = preset"
                :class="[
                  'px-3 py-1.5 text-sm rounded-md transition-colors',
                  wordCount === preset
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700'
                ]"
              >
                {{ preset }}词
              </button>
            </div>
            <input
              v-model.number="wordCount"
              type="number"
              :min="wordCountMin"
              :max="wordCountMax"
              :step="mode === 'essay' ? 10 : 50"
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">自定义描述（可选）</label>
            <textarea
              v-model="customDescription"
              rows="3"
              placeholder="例如：以第一人称叙述、加入一个反转结局、多用被动语态..."
              class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            ></textarea>
          </div>

          <button
            @click="generate"
            :disabled="generating || words.length === 0"
            class="w-full bg-purple-600 text-white py-2.5 px-4 rounded-md hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ generating ? '生成中...' : '生成文章' }}
          </button>
        </div>
      </div>

      <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-6">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">生成结果</h2>
        <div v-if="error" class="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-sm text-red-600 dark:text-red-400">
          {{ error }}
        </div>
        <div v-if="!result && !generating" class="text-center py-16 text-gray-400 dark:text-neutral-500">
          配置左侧参数，点击"生成文章"后结果将显示在这里
        </div>
        <div v-if="generating" class="text-center py-16">
          <div class="inline-block w-8 h-8 border-4 border-purple-200 dark:border-neutral-700 border-t-purple-600 rounded-full animate-spin"></div>
          <p class="mt-3 text-sm text-gray-500 dark:text-neutral-400">正在生成文章，请稍候...</p>
        </div>
        <div v-if="result && !generating" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">文章标题</label>
            <div class="flex gap-2">
              <input
                v-model="resultTitle"
                type="text"
                class="flex-1 w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                @click="regenerateTitle"
                :disabled="generatingTitle"
                class="shrink-0 inline-flex items-center gap-1 px-3 py-2 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title="AI 重新生成标题"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h5M20 20v-5h-5M4.58 16.5a9 9 0 0014.85 2.9M19.42 7.5a9 9 0 00-14.85-2.9" />
                </svg>
                <span class="hidden sm:inline">{{ generatingTitle ? '生成中...' : 'AI标题' }}</span>
              </button>
            </div>
          </div>
          <div class="text-xs text-gray-500 dark:text-neutral-400">
            约 {{ resultWordCount }} 个英文单词
          </div>
          <div class="max-h-[45vh] overflow-y-auto rounded-md bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 p-4">
            <div class="text-sm text-gray-800 dark:text-neutral-200 whitespace-pre-wrap leading-relaxed">{{ result }}</div>
          </div>
          <div class="flex flex-col sm:flex-row gap-2 sm:gap-3">
            <button
              @click="saveArticle"
              class="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              保存并阅读
            </button>
            <button
              @click="generate"
              class="flex-1 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 py-2 px-4 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
            >
              重新生成
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
