<script setup>
import { ref, watch } from 'vue'
import { useArticleStore } from '../../stores/article'

const props = defineProps({
  article: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['close', 'saved'])

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
  const trimmedTitle = title.value.trim()
  if (!trimmedTitle) {
    alert('标题不能为空')
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
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div
    class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
    @click.self="emit('close')"
  >
    <div class="bg-white dark:bg-neutral-900 rounded-lg p-5 max-w-lg w-full mx-4">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-neutral-100 mb-4">编辑文章</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">标题</label>
          <input
            v-model="title"
            type="text"
            placeholder="输入文章标题"
            @keyup.enter="save"
            @keyup.esc="emit('close')"
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
