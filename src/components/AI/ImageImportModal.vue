<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { extractArticleFromImage, IMAGE_MAX_TOKENS } from '../../services/ai'
import { prepareImageForAI } from '../../services/image'

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  }
})
const emit = defineEmits(['close', 'extracted'])

const imageFiles = ref([])        // 已上传、待识别的图片 File 列表
const imagePreviews = ref([])     // 预览用的 object URL
const isDragging = ref(false)
const recognizingImage = ref(false)
const imageError = ref('')
const imageFileInput = ref(null)
const imageProgress = ref(0)
const imageProgressMax = ref(IMAGE_MAX_TOKENS)

const imageProgressPercent = computed(() => {
  if (!imageProgressMax.value) return 0
  return Math.min(100, Math.round((imageProgress.value / imageProgressMax.value) * 100))
})

// ---- 图片选择 / 拖拽 ----
function triggerImagePicker() {
  if (imageFileInput.value) imageFileInput.value.click()
}

function releasePreviews() {
  imagePreviews.value.forEach(u => URL.revokeObjectURL(u))
  imagePreviews.value = []
}

function acceptFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type || ''))
  if (!files.length) return

  releasePreviews()
  imageFiles.value = files
  imagePreviews.value = files.map(f => URL.createObjectURL(f))
  imageError.value = ''
  imageProgress.value = 0
  imageProgressMax.value = IMAGE_MAX_TOKENS * files.length
}

function handleImageUpload(event) {
  acceptFiles(event.target.files)
  event.target.value = ''
}

function onDrop(event) {
  isDragging.value = false
  acceptFiles(event.dataTransfer?.files)
}

function onDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    isDragging.value = false
  }
}

function removeImage(index) {
  URL.revokeObjectURL(imagePreviews.value[index])
  imageFiles.value.splice(index, 1)
  imagePreviews.value.splice(index, 1)
  imageProgressMax.value = IMAGE_MAX_TOKENS * imageFiles.value.length
  if (!imageFiles.value.length) {
    imageError.value = ''
    imageProgress.value = 0
  }
}

// ---- AI 识别并提取文章 ----
async function extractArticle() {
  if (!imageFiles.value.length || recognizingImage.value) return

  recognizingImage.value = true
  imageError.value = ''
  imageProgressMax.value = IMAGE_MAX_TOKENS * imageFiles.value.length
  imageProgress.value = 0

  try {
    const contents = []
    let title = ''
    let description = ''
    let completed = 0
    for (const file of imageFiles.value) {
      const dataUrl = await prepareImageForAI(file)
      // 流式进度：已完成图片的 token 预算 + 当前图片已生成 token
      const result = await extractArticleFromImage(dataUrl, (currentTokens) => {
        imageProgress.value = completed * IMAGE_MAX_TOKENS + currentTokens
      })
      completed++
      imageProgress.value = completed * IMAGE_MAX_TOKENS
      if (result.title && !title) title = result.title
      if (result.description && !description) description = result.description
      if (result.content) contents.push(result.content)
    }

    if (!contents.length) {
      imageError.value = '未能从图片中识别出文章内容'
      return
    }
    // 识别完成：回传结果并自动关闭
    emit('extracted', { title, description, content: contents.join('\n\n') })
    emit('close')
  } catch (e) {
    imageError.value = e.message
  } finally {
    imageProgress.value = imageProgressMax.value
    recognizingImage.value = false
  }
}

// ---- 关闭处理 ----
function handleOverlayClick() {
  if (recognizingImage.value) return
  emit('close')
}

function handleEsc(e) {
  if (e.key === 'Escape' && props.open && !recognizingImage.value) {
    emit('close')
  }
}

watch(() => props.open, (val) => {
  if (val) {
    imageFiles.value = []
    releasePreviews()
    isDragging.value = false
    recognizingImage.value = false
    imageError.value = ''
    imageProgress.value = 0
    imageProgressMax.value = IMAGE_MAX_TOKENS
  }
})

onMounted(() => window.addEventListener('keydown', handleEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', handleEsc))
</script>

<template>
  <Teleport to="body">
    <Transition name="img-overlay">
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        @click="handleOverlayClick"
      ></div>
    </Transition>

    <Transition name="img-panel">
      <div v-if="open" class="fixed inset-0 z-50">
        <div class="relative h-full w-full bg-white dark:bg-neutral-900 flex flex-col overflow-hidden">
          <div class="sm:hidden pt-[env(safe-area-inset-top)] bg-white dark:bg-neutral-900"></div>

          <!-- 头部 -->
          <div class="relative flex items-center justify-center px-5 py-3 border-b border-gray-100 dark:border-neutral-800">
            <h2 class="text-base font-semibold text-gray-900 dark:text-neutral-100">拍照导入文章</h2>
            <button
              @click="emit('close')"
              :disabled="recognizingImage"
              class="absolute right-4 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="关闭"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <!-- 内容 -->
          <div class="flex-1 overflow-y-auto">
            <div class="max-w-2xl mx-auto w-full px-5 py-5 space-y-4">
              <p class="text-sm text-gray-500 dark:text-neutral-400">
                上传图片后，AI 将自动识别图片中的英文文章，完成后返回并填入表单。
              </p>

              <!-- 拖拽上传区 -->
              <div
                @click="triggerImagePicker"
                @dragover.prevent="isDragging = true"
                @dragleave.prevent="onDragLeave"
                @drop.prevent="onDrop"
                class="flex flex-col items-center justify-center gap-2 py-8 px-4 rounded-xl border-2 border-dashed cursor-pointer transition-colors"
                :class="isDragging
                  ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/30'
                  : 'border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/50 hover:border-purple-400 hover:bg-purple-50/50 dark:hover:bg-neutral-800'"
              >
                <svg class="w-10 h-10 text-gray-400 dark:text-neutral-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p class="text-sm text-gray-600 dark:text-neutral-300">
                  拖拽图片到此处，或<span class="text-purple-600 dark:text-purple-400 font-medium">点击选择</span>
                </p>
                <p class="text-xs text-gray-400 dark:text-neutral-500">支持多张图片</p>
              </div>
              <input ref="imageFileInput" type="file" accept="image/*" multiple class="hidden" @change="handleImageUpload" />

              <!-- 缩略图预览 -->
              <div v-if="imageFiles.length" class="flex flex-wrap gap-2">
                <div v-for="(src, i) in imagePreviews" :key="i" class="relative">
                  <img
                    :src="src"
                    alt="图片预览"
                    class="w-20 h-20 object-cover rounded-md border border-gray-200 dark:border-neutral-700"
                  />
                  <button
                    @click="removeImage(i)"
                    :disabled="recognizingImage"
                    class="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center rounded-full bg-gray-700 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="移除"
                  >
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 进度条 -->
              <div v-if="recognizingImage" class="p-4 rounded-lg border border-purple-200 dark:border-neutral-700 bg-purple-50/50 dark:bg-neutral-800">
                <div class="flex items-center justify-between mb-1.5">
                  <span class="text-xs font-medium text-purple-700 dark:text-purple-300">AI 正在识别图片…</span>
                  <span class="text-xs text-gray-500 dark:text-neutral-400">{{ imageProgressPercent }}%</span>
                </div>
                <div class="h-2 w-full rounded-full bg-purple-100 dark:bg-neutral-700 overflow-hidden">
                  <div class="h-full rounded-full bg-purple-600" :style="{ width: imageProgressPercent + '%' }"></div>
                </div>
                <p class="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
                  识别进度 {{ imageProgress }} / {{ imageProgressMax }} tokens（共 {{ imageFiles.length }} 张图片）
                </p>
              </div>

              <p v-if="imageError" class="text-sm text-red-600 dark:text-red-400">{{ imageError }}</p>

              <!-- 提取按钮 -->
              <button
                @click="extractArticle"
                :disabled="!imageFiles.length || recognizingImage"
                class="w-full inline-flex items-center justify-center gap-2 bg-purple-600 text-white py-3 px-5 rounded-xl hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                <svg v-if="recognizingImage" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
                </svg>
                {{ recognizingImage ? '识别中...' : '提取文章' }}
              </button>
              <p class="text-center text-xs text-gray-400 dark:text-neutral-500">
                识别完成后将自动返回并填入表单
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<!-- Transition 进出动画需定义在全局样式，才能被 Vue 动态添加的类引用 -->
<style>
.img-overlay-enter-active {
  transition: opacity 0.25s ease-out;
}
.img-overlay-leave-active {
  transition: opacity 0.2s ease-in;
}
.img-overlay-enter-from,
.img-overlay-leave-to {
  opacity: 0;
}
.img-panel-enter-active {
  animation: img-slide-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.img-panel-leave-active {
  animation: img-slide-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes img-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes img-slide-down {
  from { transform: translateY(0); }
  to { transform: translateY(100%); }
}
</style>
