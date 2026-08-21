<script setup>
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Send, X } from 'lucide-vue-next'
import { chatAboutSelection } from '../../services/ai'

const props = defineProps({
  text: String,
  context: String
})

const emit = defineEmits(['close'])

// 语法解析类快捷问题（点击即发送）
const quickQuestions = [
  '解析这句话的语法结构',
  '分析句子成分（主谓宾定状补）',
  '这句话的时态和语态是什么，为什么？',
  '讲解其中的重点词组和搭配'
]

const messages = ref([]) // [{ role: 'user' | 'assistant', content }]
const input = ref('')
const sending = ref(false)
const sendingError = ref(false)
const textExpanded = ref(false)

const listRef = ref(null)
const inputRef = ref(null)

let ctrl = null // 进行中请求的 AbortController
let alive = true // 卸载守卫：组件卸载后不再更新状态

// 解析 **加粗** 标记为高亮片段（与 WordPopup 的"在文中"高亮一致，项目无 Markdown 库）
function parseHighlightParts(raw) {
  const text = String(raw || '')
  const parts = []
  const regex = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), highlight: false })
    }
    parts.push({ text: match[1], highlight: true })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), highlight: false })
  }
  return parts.length > 0 ? parts : [{ text: '', highlight: false }]
}

async function scrollToBottom() {
  await nextTick()
  if (listRef.value) {
    listRef.value.scrollTop = listRef.value.scrollHeight
  }
}

// 输入框自适应高度（上限 128px 后内部滚动）
function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 128)}px`
}

watch(input, () => nextTick(autoResize))

function handleKeydown(e) {
  // Enter 发送 / Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function send(question) {
  const content = String(question ?? input.value).trim()
  if (!content || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', content })
  sendToAI()
}

async function sendToAI() {
  sending.value = true
  sendingError.value = false
  // 历史不含本轮刚加入的用户消息
  const history = messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
  messages.value.push({ role: 'assistant', content: '' })
  const assistantIndex = messages.value.length - 1
  await scrollToBottom()

  ctrl = new AbortController()
  try {
    const full = await chatAboutSelection(history, props.text, props.context, (_delta, fullText) => {
      if (!alive) return
      messages.value[assistantIndex].content = fullText
      scrollToBottom()
    }, ctrl.signal)
    if (!alive) return
    if (!full) {
      throw new Error('生成结果为空')
    }
    messages.value[assistantIndex].content = full
  } catch (error) {
    if (!alive || error?.name === 'AbortError') return
    console.error('追问解析生成失败:', error.message)
    sendingError.value = true
  } finally {
    ctrl = null
    if (alive) {
      sending.value = false
    }
  }
}

// 重试：移除末尾空的 assistant 消息后重新请求
function retrySend() {
  if (sending.value) return
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && !last.content) {
    messages.value.pop()
  }
  sendToAI()
}

function close() {
  ctrl?.abort()
  emit('close')
}

function handleEsc(e) {
  if (e.key === 'Escape') close()
}

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
  inputRef.value?.focus()
})

onUnmounted(() => {
  alive = false
  ctrl?.abort()
  document.removeEventListener('keydown', handleEsc)
})
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
    <div class="absolute inset-0 bg-black/40" @click="close"></div>
    <div class="relative w-full sm:max-w-2xl bg-white dark:bg-neutral-900 rounded-t-2xl sm:rounded-lg shadow-xl border border-gray-200 dark:border-neutral-800 flex flex-col h-[90vh] sm:h-auto sm:max-h-[80vh]">
      <div class="flex justify-center pt-2 sm:hidden">
        <div class="w-10 h-1 rounded-full bg-gray-300 dark:bg-neutral-700"></div>
      </div>

      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-neutral-800">
        <h3 class="text-base font-bold text-gray-900 dark:text-neutral-100">追问解析</h3>
        <button
          @click="close"
          class="p-1 -m-1 text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200"
          aria-label="关闭"
        >
          <X class="w-4 h-4" />
        </button>
      </div>

      <div class="px-4 pt-3">
        <div class="bg-gray-50 dark:bg-neutral-800/60 rounded-md px-3 py-2">
          <p
            class="text-sm text-gray-600 dark:text-neutral-300 whitespace-pre-wrap break-words"
            :class="{ 'line-clamp-2': !textExpanded }"
          >{{ text }}</p>
          <button
            v-if="(text || '').length > 120"
            @click="textExpanded = !textExpanded"
            class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 mt-1"
          >{{ textExpanded ? '收起' : '展开全文' }}</button>
        </div>
      </div>

      <div ref="listRef" class="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        <div v-if="messages.length === 0" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            v-for="q in quickQuestions"
            :key="q"
            @click="send(q)"
            class="text-left text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 text-gray-700 dark:text-neutral-300 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
          >{{ q }}</button>
        </div>
        <div v-else class="space-y-3">
          <template v-for="(m, i) in messages" :key="i">
            <div v-if="m.role === 'user'" class="flex justify-end">
              <div class="max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-br-md px-3 py-2 text-sm whitespace-pre-wrap break-words">{{ m.content }}</div>
            </div>
            <div v-else class="flex justify-start">
              <div class="max-w-[90%] bg-gray-100 dark:bg-neutral-800 text-gray-800 dark:text-neutral-200 rounded-2xl rounded-bl-md px-3 py-2 text-sm whitespace-pre-wrap break-words">
                <template v-if="m.content">
                  <template v-for="(part, j) in parseHighlightParts(m.content)" :key="j">
                    <span v-if="part.highlight" class="font-medium text-blue-600 dark:text-blue-400">{{ part.text }}</span>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </template>
                <div v-else-if="!sendingError" class="flex items-center gap-2">
                  <div class="animate-spin inline-block w-4 h-4 border-2 border-gray-300 dark:border-neutral-600 border-t-blue-600 rounded-full"></div>
                  <span class="text-xs text-gray-400 dark:text-neutral-500">正在思考…</span>
                </div>
              </div>
            </div>
          </template>
          <div v-if="sendingError" class="flex items-center gap-2">
            <span class="text-xs text-red-500 dark:text-red-400">生成失败</span>
            <button
              @click="retrySend"
              class="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
            >重试</button>
          </div>
        </div>
      </div>

      <div class="px-4 py-3 border-t border-gray-100 dark:border-neutral-800">
        <div class="flex items-end gap-2">
          <textarea
            ref="inputRef"
            v-model="input"
            rows="1"
            placeholder="针对这段文本提问，如：为什么用过去完成时？"
            class="flex-1 resize-none max-h-32 px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            @keydown="handleKeydown"
          ></textarea>
          <button
            @click="send()"
            :disabled="sending || !input.trim()"
            class="flex-shrink-0 p-2.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="发送"
          >
            <div v-if="sending" class="animate-spin w-5 h-5 border-2 border-white/40 border-t-white rounded-full"></div>
            <Send v-else class="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
