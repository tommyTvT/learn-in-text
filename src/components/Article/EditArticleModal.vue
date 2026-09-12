<script setup>
import { ref, watch } from 'vue'
import { useArticleStore } from '../../stores/article'
import { alert, confirmDialog } from '../../services/dialog'
import { errorText } from '../../services/errors'
import { useDialogA11y } from '../../composables/useDialogA11y'

const props = defineProps({
  article: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'saved'])

// 弹窗无障碍：Esc 关闭（保存中禁止）、打开时焦点移入、关闭时归还、Tab 循环。
// 本组件挂载即打开（父级 v-if 控制显隐），isOpen 恒为 true。
const panelRef = ref(null)
useDialogA11y({
  isOpen: () => true,
  onClose: () => {
    if (!saving.value) emit('close')
  },
  panelRef,
  canClose: () => !saving.value
})

const articleStore = useArticleStore()

const title = ref(props.article.title)
const description = ref(props.article.description || '')
const saving = ref(false)

// 复用同一实例编辑不同文章时，重新带入初始值
watch(() => props.article, (a) => {
  title.value = a.title
  description.value = a.description || ''
})

async function save() {
  if (saving.value) return
  const trimmedTitle = title.value.trim()
  if (!trimmedTitle) {
    await alert('标题不能为空')
    return
  }
  saving.value = true
  try {
    await articleStore.updateArticle(props.article.id, {
      title: trimmedTitle,
      description: description.value.trim()
    })
    emit('saved')
    emit('close')
  } catch (e) {
    // 此前只有 try/finally：写库失败时异常直接外抛，弹窗既不关闭也不提示，
    // 用户以为「点了没反应」
    await alert('保存失败：' + errorText(e, '请重试'))
  } finally {
    saving.value = false
  }
}

// 回车保存：中文等输入法用回车确认候选词，不能当作提交（否则会保存半截标题）
function onTitleEnter(e) {
  if (e?.isComposing) return
  save()
}
</script>

<template>
  <div
    class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    @click.self="emit('close')"
  >
    <div
      ref="panelRef"
      role="dialog"
      aria-modal="true"
      aria-label="编辑文章"
      class="bg-white dark:bg-neutral-900 rounded-lg p-5 max-w-lg w-full mx-4"
    >
      <h3 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">编辑文章</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">标题</label>
          <input
            v-model="title"
            type="text"
            placeholder="输入文章标题"
            @keyup.enter="onTitleEnter"
            class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
            autofocus
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">
            描述
            <span class="text-xs text-gray-400 dark:text-neutral-500">（可选）</span>
          </label>
          <textarea
            v-model="description"
            rows="3"
            placeholder="一句话概括文章大致内容..."
            class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
          ></textarea>
        </div>
        <div class="flex space-x-3">
          <button
            @click="save"
            :disabled="saving"
            class="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ saving ? '保存中...' : '保存' }}
          </button>
          <button
            @click="emit('close')"
            class="flex-1 bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 py-2 px-4 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
