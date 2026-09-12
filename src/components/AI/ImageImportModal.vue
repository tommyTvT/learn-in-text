<script setup>
import { ref, computed, watch } from 'vue'
import { extractArticleFromImages, IMAGE_TOKENS_BUDGET } from '../../services/ai'
import { prepareImageForAI } from '../../services/image'
import { pickFiles } from '../../services/filePicker'
import { useDialogA11y } from '../../composables/useDialogA11y'
import { errorText } from '../../services/errors'

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

const imageProgress = ref(0)
const imageProgressMax = ref(IMAGE_TOKENS_BUDGET)

const imageProgressPercent = computed(() => {
  if (!imageProgressMax.value) return 0
  return Math.min(100, Math.round((imageProgress.value / imageProgressMax.value) * 100))
})

// ---- 图片选择 / 拖拽 ----
// 用运行时原生 input 选择文件：模板里的 <input type="file"> 会被 uni-app
// 编译成 uni-input 组件，导致 accept/multiple/ref.click()/change 全部失效
async function triggerImagePicker() {
  const files = await pickFiles({ accept: 'image/*', multiple: true })
  if (files.length) acceptFiles(files)
}

function releasePreviews() {
  imagePreviews.value.forEach(u => URL.revokeObjectURL(u))
  imagePreviews.value = []
}

function acceptFiles(fileList) {
  const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type || ''))
  if (!files.length) return

  // 追加而非覆盖：新图片与已上传图片共存
  imageFiles.value.push(...files)
  imagePreviews.value.push(...files.map(f => URL.createObjectURL(f)))
  imageError.value = ''
  imageProgress.value = 0
  imageProgressMax.value = IMAGE_TOKENS_BUDGET * imageFiles.value.length
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
  imageProgressMax.value = IMAGE_TOKENS_BUDGET * imageFiles.value.length
  if (!imageFiles.value.length) {
    imageError.value = ''
    imageProgress.value = 0
  }
}

// ---- AI 识别并提取文章 ----
// 识别中允许取消：abort 会中止在途 fetch，避免无谓的 token 消耗与等待
let recognizeCtrl = null

function cancelRecognize() {
  recognizeCtrl?.abort()
}

async function extractArticle() {
  if (!imageFiles.value.length || recognizingImage.value) return

  recognizingImage.value = true
  imageError.value = ''
  imageProgressMax.value = IMAGE_TOKENS_BUDGET * imageFiles.value.length
  imageProgress.value = 0
  // 用局部变量持有 controller：finally 会把模块变量置 null，后续不能再读它
  const ctrl = new AbortController()
  recognizeCtrl = ctrl

  try {
    // 本地预处理所有图片，然后一次请求携带全部图片识别（跨图拼接由模型完成）
    const dataUrls = await Promise.all(imageFiles.value.map(prepareImageForAI))
    const result = await extractArticleFromImages(dataUrls, (currentTokens) => {
      imageProgress.value = currentTokens
    }, ctrl.signal)

    if (ctrl.signal.aborted) return // 已取消：不回传结果
    if (!result.content) {
      imageError.value = '未能从图片中识别出文章内容'
      return
    }
    // 识别完成：回传结果并自动关闭
    emit('extracted', { title: result.title, description: result.description, content: result.content })
    emit('close')
  } catch (e) {
    if (ctrl.signal.aborted || e?.name === 'AbortError') {
      return // 用户主动取消：静默复位，不当作错误展示
    }
    // 归一化：reject 值可能是字符串/undefined，直接取 .message 会得到 undefined，
    // 错误区（v-if="imageError"）随之不渲染，用户看不到任何失败原因
    imageError.value = errorText(e, '识别失败，请重试')
  } finally {
    recognizeCtrl = null
    imageProgress.value = imageProgressMax.value
    recognizingImage.value = false
  }
}

// ---- 关闭处理 ----
function handleOverlayClick() {
  if (recognizingImage.value) return
  emit('close')
}

watch(() => props.open, (val) => {
  if (val) {
    imageFiles.value = []
    releasePreviews()
    isDragging.value = false
    recognizingImage.value = false
    imageError.value = ''
    imageProgress.value = 0
    imageProgressMax.value = IMAGE_TOKENS_BUDGET
  }
})

// 弹窗无障碍：Esc 关闭（识别进行中禁止）、打开时焦点移入、关闭时归还、Tab 循环
// （composable 内部已做非 H5 端守卫，替代此前无守卫的 window 监听）
const panelRef = ref(null)
useDialogA11y({
  isOpen: () => props.open,
  onClose: () => emit('close'),
  panelRef,
  canClose: () => !recognizingImage.value
})
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
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          aria-label="拍照导入文章"
          class="relative h-full w-full bg-white dark:bg-neutral-900 flex flex-col overflow-hidden"
        >
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
                    aria-label="移除图片"
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
                <!-- 识别中提供取消入口：abort 中止在途请求，无需等满超时 -->
                <button
                  type="button"
                  @click="cancelRecognize"
                  class="mt-2 w-full px-3 py-1.5 text-xs text-gray-600 dark:text-neutral-300 border border-gray-300 dark:border-neutral-600 rounded-md hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors"
                >
                  取消识别
                </button>
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
