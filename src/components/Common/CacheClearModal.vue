<script setup>
import { ref, computed, watch } from 'vue'
import { X, LoaderCircle, Trash2, FileText, CheckSquare, Square } from 'lucide-vue-next'
import { cacheService, articleService } from '../../services/db'
import { alert, confirmDialog } from '../../services/dialog'
import { useDialogA11y } from '../../composables/useDialogA11y'
import { errorText } from '../../services/errors'

const props = defineProps({
  open: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'done'])

const TYPE_OPTIONS = [
  { key: 'words', label: '单词释义', desc: 'AI 生成的单词释义，清除后点击单词时重新生成' },
  { key: 'contextTranslations', label: '「在文中」释义', desc: '单词在文中实际含义的解释缓存' },
  { key: 'selectionTranslations', label: '划词翻译', desc: '拖选文字的翻译缓存' }
]

const types = ref({ words: false, contextTranslations: false, selectionTranslations: false })
const articleScope = ref('all') // 'all' | 'custom'
const selectedArticleIds = ref([])
const articles = ref([])
const stats = ref(null)
const statsLoading = ref(false)
const clearing = ref(false)
const result = ref(null)
const error = ref('')

const currentArticleIds = computed(() =>
  articleScope.value === 'all' ? null : [...selectedArticleIds.value]
)

const selectedTypes = computed(() => TYPE_OPTIONS.filter(t => types.value[t.key]).map(t => t.key))
const canClear = computed(() =>
  !clearing.value &&
  selectedTypes.value.length > 0 &&
  (articleScope.value === 'all' || selectedArticleIds.value.length > 0)
)

async function refreshStats() {
  statsLoading.value = true
  try {
    stats.value = await cacheService.getStats(currentArticleIds.value)
  } catch (e) {
    // 统计失败不阻塞选择，数量显示为 -
    stats.value = null
  } finally {
    statsLoading.value = false
  }
}

async function load() {
  try {
    articles.value = await articleService.getAll()
  } catch (e) {
    articles.value = []
  }
  refreshStats()
}

watch(() => props.open, (open) => {
  if (!open) return
  // 每次打开重置为初始状态
  types.value = { words: false, contextTranslations: false, selectionTranslations: false }
  articleScope.value = 'all'
  selectedArticleIds.value = []
  result.value = null
  error.value = ''
  load()
})

watch([types, articleScope, selectedArticleIds], refreshStats, { deep: true })

// ---- 关闭守卫 ----
// 清除进行中禁止一切关闭入口：结果与失败信息只在弹窗内展示，
// 中途关掉用户就永远看不到清除结果（只能重新打开再清一次）
function requestClose() {
  if (clearing.value) return
  emit('close')
}

// 弹窗无障碍：Esc 关闭（清除中禁止）、打开时焦点移入、关闭时归还、Tab 循环
const panelRef = ref(null)
useDialogA11y({
  isOpen: () => props.open,
  onClose: () => emit('close'),
  panelRef,
  canClose: () => !clearing.value
})

function toggleArticle(id) {
  const idx = selectedArticleIds.value.indexOf(id)
  if (idx >= 0) selectedArticleIds.value.splice(idx, 1)
  else selectedArticleIds.value.push(id)
}

async function handleClear() {
  const typeLabels = selectedTypes.value
    .map(k => TYPE_OPTIONS.find(t => t.key === k).label)
    .join('、')
  const scopeText = articleScope.value === 'all'
    ? '全部文章'
    : `选中的 ${selectedArticleIds.value.length} 篇文章`
  if (!await confirmDialog(`确定清除「${typeLabels}」（${scopeText}）吗？\n清除后相关内容会在再次使用时重新生成，单词标记不受影响。`, '确认', { destructive: true })) return

  clearing.value = true
  error.value = ''
  try {
    result.value = await cacheService.clearCaches(types.value, currentArticleIds.value)
    refreshStats()
    emit('done')
  } catch (e) {
    error.value = '清除失败：' + errorText(e, '请重试')
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="cache-overlay">
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        @click="requestClose"
      ></div>
    </Transition>

    <Transition name="cache-panel">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          aria-label="清除缓存"
          class="pointer-events-auto w-full max-w-lg max-h-[85vh] flex flex-col bg-white dark:bg-neutral-900 rounded-xl shadow-xl border border-gray-200 dark:border-neutral-800 overflow-hidden"
        >
          <!-- 头部 -->
          <div class="relative flex items-center justify-center px-5 py-3 border-b border-gray-100 dark:border-neutral-800 shrink-0">
            <h2 class="text-base font-semibold text-gray-900 dark:text-neutral-100">清除缓存</h2>
            <button
              @click="requestClose"
              class="absolute right-4 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
              aria-label="关闭"
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          <!-- 内容滚动区 -->
          <div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <!-- 清除类型 -->
            <div>
              <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">清除类型</h3>
              <div class="space-y-2">
                <button
                  v-for="t in TYPE_OPTIONS"
                  :key="t.key"
                  type="button"
                  class="w-full flex items-start gap-3 text-left rounded-lg border p-3 transition-colors cursor-pointer"
                  :class="types[t.key]
                    ? 'border-blue-500 bg-blue-50 dark:bg-neutral-800'
                    : 'border-gray-200 dark:border-neutral-800 bg-gray-50 dark:bg-neutral-800/60 hover:border-blue-300 dark:hover:border-neutral-600'"
                  @click="types[t.key] = !types[t.key]"
                >
                  <component
                    :is="types[t.key] ? CheckSquare : Square"
                    class="w-4.5 h-4.5 mt-0.5 shrink-0"
                    :class="types[t.key] ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-neutral-500'"
                  />
                  <span class="flex-1 min-w-0">
                    <span class="flex items-center justify-between gap-2">
                      <span class="text-sm font-medium text-gray-900 dark:text-neutral-100">{{ t.label }}</span>
                      <span
                        v-if="stats"
                        class="text-xs px-1.5 py-0.5 rounded-full shrink-0"
                        :class="stats[t.key] > 0
                          ? 'bg-gray-200 dark:bg-neutral-700 text-gray-600 dark:text-neutral-300'
                          : 'bg-gray-100 dark:bg-neutral-800 text-gray-400 dark:text-neutral-500'"
                      >{{ stats[t.key] }} 条</span>
                    </span>
                    <span class="block text-xs text-gray-500 dark:text-neutral-400 mt-0.5">{{ t.desc }}</span>
                  </span>
                </button>
              </div>
            </div>

            <!-- 文章范围 -->
            <div>
              <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2">文章范围</h3>
              <div class="grid grid-cols-2 gap-2 mb-2">
                <button
                  type="button"
                  class="px-3 py-2 rounded-md border text-sm font-medium transition-colors cursor-pointer"
                  :class="articleScope === 'all'
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-neutral-700 dark:text-neutral-100'
                    : 'border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'"
                  @click="articleScope = 'all'"
                >全部文章</button>
                <button
                  type="button"
                  class="px-3 py-2 rounded-md border text-sm font-medium transition-colors cursor-pointer"
                  :class="articleScope === 'custom'
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-neutral-700 dark:text-neutral-100'
                    : 'border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'"
                  @click="articleScope = 'custom'"
                >指定文章</button>
              </div>

              <div v-if="articleScope === 'custom'" class="rounded-lg border border-gray-200 dark:border-neutral-800 divide-y divide-gray-100 dark:divide-neutral-800 max-h-48 overflow-y-auto">
                <div v-if="articles.length === 0" class="px-3 py-4 text-sm text-gray-500 dark:text-neutral-400 text-center">
                  暂无文章
                </div>
                <button
                  v-for="a in articles"
                  :key="a.id"
                  type="button"
                  class="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
                  @click="toggleArticle(a.id)"
                >
                  <component
                    :is="selectedArticleIds.includes(a.id) ? CheckSquare : Square"
                    class="w-4 h-4 shrink-0"
                    :class="selectedArticleIds.includes(a.id) ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-neutral-500'"
                  />
                  <FileText class="w-4 h-4 shrink-0 text-gray-400 dark:text-neutral-500" />
                  <span
                    class="flex-1 min-w-0 truncate text-sm"
                    :class="selectedArticleIds.includes(a.id)
                      ? 'text-gray-900 dark:text-neutral-100 font-medium'
                      : 'text-gray-600 dark:text-neutral-300'"
                  >{{ a.title }}</span>
                </button>
              </div>
            </div>

            <p class="text-xs text-gray-500 dark:text-neutral-400">
              清除后相关内容会在再次使用时重新生成（重新消耗 AI 请求），单词标记与文章内容不受影响。
            </p>

            <!-- 结果 / 错误 -->
            <div
              v-if="result"
              class="p-3 rounded-md text-sm bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400"
            >
              清除完成：单词释义 {{ result.words }} 条、「在文中」释义 {{ result.contextTranslations }} 条、划词翻译 {{ result.selectionTranslations }} 条
            </div>
            <div
              v-if="error"
              class="p-3 rounded-md text-sm bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400"
            >
              {{ error }}
            </div>
          </div>

          <!-- 底部 -->
          <div class="flex items-center justify-end gap-3 px-5 py-3 border-t border-gray-100 dark:border-neutral-800 shrink-0">
            <button
              @click="requestClose"
              :disabled="clearing"
              class="px-4 py-2 text-sm text-gray-600 dark:text-neutral-400 border border-gray-300 dark:border-neutral-700 rounded-md hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              关闭
            </button>
            <button
              @click="handleClear"
              :disabled="!canClear"
              class="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <LoaderCircle v-if="clearing" class="w-4 h-4 animate-spin" />
              <Trash2 v-else class="w-4 h-4" />
              {{ clearing ? '清除中...' : '清除所选缓存' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cache-overlay-enter-active,
.cache-overlay-leave-active {
  transition: opacity 0.15s ease;
}
.cache-overlay-enter-from,
.cache-overlay-leave-to {
  opacity: 0;
}

.cache-panel-enter-active,
.cache-panel-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.cache-panel-enter-from,
.cache-panel-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(8px);
}
</style>
