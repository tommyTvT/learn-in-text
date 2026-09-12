<script setup>
import { ref, computed, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useDialogA11y } from '../../composables/useDialogA11y'
import { testConnection } from '../../services/ai'
import { X, ChevronDown } from 'lucide-vue-next'

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  },
  // 'text' 文本模型 | 'vision' 视觉模型
  type: {
    type: String,
    default: 'text'
  }
})
const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()

const isVision = computed(() => props.type === 'vision')
const title = computed(() => (isVision.value ? '视觉模型' : '文本模型'))

// 直接绑定 store 中的配置
const config = computed(() =>
  isVision.value ? settingsStore.visionModelConfig : settingsStore.textModelConfig
)

const selectedProviderId = computed({
  get: () => config.value.providerId,
  set: (val) => {
    if (isVision.value) settingsStore.setVisionModel(val, config.value.model)
    else settingsStore.setTextModel(val, config.value.model)
  }
})

const selectedProvider = computed(() =>
  settingsStore.providers.find(p => p.id === selectedProviderId.value) || null
)

const model = computed({
  get: () => config.value.model,
  set: (val) => {
    if (isVision.value) settingsStore.setVisionModel(config.value.providerId, val)
    else settingsStore.setTextModel(config.value.providerId, val)
  }
})

// ---- 连接测试 ----
const testing = ref(false)
const testResult = ref(null)

async function handleTestConnection() {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testConnection(props.type)
  } catch (error) {
    testResult.value = { success: false, message: error.message }
  } finally {
    testing.value = false
  }
}

// ---- 模型列表：直接读取供应商配置中已暴露的模型（本地存储，无需在线拉取） ----
const modelDropdownOpen = ref(false)
const modelFilter = ref('')
// true = 通过「展示模型列表」按钮打开，显示全量不过滤；
// 点击/输入输入框时恢复为按输入内容过滤的默认模式
const showAllModels = ref(false)

/** 当前所选供应商已暴露的模型列表（undefined = 未配置，视为全部暴露但本地无列表） */
const exposedModels = computed(() => {
  const p = settingsStore.providers.find(x => x.id === config.value.providerId)
  return Array.isArray(p?.exposedModels) ? p.exposedModels : []
})

const filteredModels = computed(() => {
  if (showAllModels.value) return exposedModels.value
  const keyword = modelFilter.value.trim().toLowerCase()
  if (!keyword) return exposedModels.value
  return exposedModels.value.filter(m => m.toLowerCase().includes(keyword))
})

/** 手填模型不在暴露列表中的提示（严格遵循供应商暴露配置） */
const unexposedWarning = computed(() => {
  const m = model.value?.trim()
  if (!m || !exposedModels.value.length) return ''
  if (!exposedModels.value.includes(m)) {
    return `模型「${m}」未在供应商配置中暴露，可能不可用`
  }
  return ''
})

function selectModel(m) {
  model.value = m
  modelDropdownOpen.value = false
  showAllModels.value = false
}

function openModelDropdown() {
  if (!exposedModels.value.length) return
  showAllModels.value = false
  modelFilter.value = model.value || ''
  modelDropdownOpen.value = true
}

// 「展示模型列表」：显示全量已暴露模型，不按输入框内容过滤
function toggleFullModelList() {
  if (!exposedModels.value.length) return
  if (showAllModels.value && modelDropdownOpen.value) {
    modelDropdownOpen.value = false
    showAllModels.value = false
    return
  }
  showAllModels.value = true
  modelDropdownOpen.value = true
}

function onModelInput() {
  modelFilter.value = model.value
  if (exposedModels.value.length) {
    showAllModels.value = false
    modelDropdownOpen.value = true
  }
}

function closeModelDropdown() {
  // 全量列表模式下不因输入框失焦收起（用户可能正在浏览列表），由按钮/选择/点遮罩关闭
  if (showAllModels.value) return
  setTimeout(() => {
    modelDropdownOpen.value = false
    showAllModels.value = false
  }, 150)
}

// 切换供应商时收起下拉（模型列表随供应商配置自动切换）
watch(selectedProviderId, () => {
  modelDropdownOpen.value = false
  showAllModels.value = false
  modelFilter.value = ''
})

watch(() => props.open, (val) => {
  if (val) {
    modelDropdownOpen.value = false
    showAllModels.value = false
    modelFilter.value = ''
    testResult.value = null
  }
})

function handleOverlayClick() {
  emit('close')
}

// 弹窗无障碍：Esc 关闭、打开时焦点移入面板、关闭时焦点归还、Tab 循环
// （composable 内部已做非 H5 端守卫，替代此前无守卫的 window 监听）
const panelRef = ref(null)
useDialogA11y({
  isOpen: () => props.open,
  onClose: () => emit('close'),
  panelRef
})

// 模型输入框的 Esc：下拉展开时只关闭下拉并阻止冒泡，
// 否则会连整个弹窗一起关掉（用户本意只是收起下拉）
function onModelEsc(e) {
  if (modelDropdownOpen.value) {
    e.stopPropagation()
    modelDropdownOpen.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="ai-overlay">
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        @click="handleOverlayClick"
      ></div>
    </Transition>

    <Transition name="ai-panel">
      <div v-if="open" class="fixed inset-0 z-50">
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          :aria-label="`${title}配置`"
          class="relative h-full w-full bg-white dark:bg-neutral-900 flex flex-col overflow-hidden"
        >
          <div class="sm:hidden pt-[env(safe-area-inset-top)] bg-white dark:bg-neutral-900"></div>

          <!-- 头部 -->
          <div class="relative flex items-center justify-center px-5 py-3 border-b border-gray-100 dark:border-neutral-800">
            <h2 class="text-base font-semibold text-gray-900 dark:text-neutral-100">{{ title }}配置</h2>
            <button
              @click="emit('close')"
              class="absolute right-4 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
              aria-label="关闭"
            >
              <X class="w-5 h-5" />
            </button>
          </div>

          <!-- 内容 -->
          <div class="flex-1 overflow-y-auto">
            <div class="max-w-2xl mx-auto w-full px-5 py-4 space-y-5">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">供应商</label>
                <select
                  v-model="selectedProviderId"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option v-for="provider in settingsStore.providers" :key="provider.id" :value="provider.id">
                    {{ provider.name }}{{ provider.apiKey ? '' : '（未配置 Key）' }}
                  </option>
                </select>
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  供应商为共享资源，文本模型与视觉模型可选用同一供应商，也可不同
                </p>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">
                  模型
                  <span v-if="isVision" class="text-xs text-gray-400 dark:text-neutral-500">（留空则复用文本模型）</span>
                </label>
                <div class="flex gap-2">
                  <div class="relative flex-1">
                    <input
                      v-model="model"
                      @input="onModelInput"
                      @focus="openModelDropdown"
                      @blur="closeModelDropdown"
                      @keydown.esc="onModelEsc"
                      type="text"
                      :placeholder="isVision ? '留空则复用文本模型' : '模型名称，如 deepseek-v4-flash'"
                      class="w-full px-3 py-2 pr-8 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                    />
                    <button
                      v-if="exposedModels.length"
                      @mousedown.prevent="modelDropdownOpen = !modelDropdownOpen"
                      type="button"
                      class="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 cursor-pointer"
                    >
                      <ChevronDown :class="['w-4 h-4 transition-transform', modelDropdownOpen ? 'rotate-180' : '']" />
                    </button>

                    <!-- 模型下拉面板 -->
                    <div
                      v-if="modelDropdownOpen && exposedModels.length"
                      class="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg"
                    >
                      <div class="sticky top-0 px-3 py-1.5 text-xs text-gray-400 dark:text-neutral-500 bg-gray-50 dark:bg-neutral-800 border-b border-gray-100 dark:border-neutral-700">
                        共 {{ filteredModels.length }} 个模型{{ !showAllModels && modelFilter ? '（已过滤）' : '' }}
                      </div>
                      <button
                        v-for="m in filteredModels"
                        :key="m"
                        @mousedown.prevent="selectModel(m)"
                        type="button"
                        :class="[
                          'block w-full text-left px-3 py-2 text-sm truncate transition-colors cursor-pointer',
                          m === model
                            ? 'bg-blue-50 text-blue-700 font-medium dark:bg-neutral-700 dark:text-blue-400'
                            : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700'
                        ]"
                      >
                        {{ m }}
                      </button>
                      <div
                        v-if="!filteredModels.length"
                        class="px-3 py-3 text-sm text-gray-400 dark:text-neutral-500 text-center"
                      >
                        没有匹配「{{ modelFilter }}」的模型
                      </div>
                    </div>
                  </div>
                  <button
                    @click="toggleFullModelList"
                    :disabled="!exposedModels.length"
                    class="shrink-0 px-3 py-2 text-sm bg-gray-100 dark:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  >
                    {{ showAllModels && modelDropdownOpen ? '收起列表' : '展示模型列表' }}
                  </button>
                </div>
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  {{ exposedModels.length
                    ? '可从已暴露的模型列表中选择，或直接输入筛选'
                    : '该供应商暂未在「管理供应商」中暴露模型，可手动填写模型名称' }}
                </p>
                <p v-if="unexposedWarning" class="text-xs text-amber-600 dark:text-amber-400 mt-1">{{ unexposedWarning }}</p>
              </div>

              <div class="flex items-center space-x-3">
                <button
                  @click="handleTestConnection"
                  :disabled="testing || !selectedProvider?.endpoint || !selectedProvider?.apiKey"
                  class="px-3 py-2 text-sm bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  {{ testing ? '测试中...' : '测试连接' }}
                </button>
                <span class="text-xs text-gray-400 dark:text-neutral-500">测试当前所选供应商与模型的连接</span>
              </div>
              <div
                v-if="testResult"
                :class="[
                  'p-3 rounded-md text-sm',
                  testResult.success ? 'bg-green-50 dark:bg-neutral-800 text-green-800 dark:text-green-400' : 'bg-red-50 dark:bg-neutral-800 text-red-800 dark:text-red-400'
                ]"
              >
                {{ testResult.message }}
              </div>

              <div v-if="selectedProvider?.preset" class="bg-gray-50 dark:bg-neutral-800 rounded-md p-3 text-sm text-gray-600 dark:text-neutral-400">
                接口地址：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ selectedProvider.endpoint }}</span>
              </div>
            </div>
          </div>

          <!-- 底部 -->
          <div class="px-5 py-3 border-t border-gray-100 dark:border-neutral-800 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div class="max-w-2xl mx-auto">
              <button
                @click="emit('close')"
                class="w-full px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium cursor-pointer"
              >
                完成
              </button>
              <p class="text-center text-xs text-gray-400 dark:text-neutral-500 mt-2">
                配置自动保存
              </p>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
/* 复用 AIConfigModal 定义的过渡动画（同名全局类，幂等） */
.ai-overlay-enter-active {
  transition: opacity 0.25s ease-out;
}
.ai-overlay-leave-active {
  transition: opacity 0.2s ease-in;
}
.ai-overlay-enter-from,
.ai-overlay-leave-to {
  opacity: 0;
}
.ai-panel-enter-active {
  animation: ai-slide-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.ai-panel-leave-active {
  animation: ai-slide-down 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
}
@keyframes ai-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes ai-slide-down {
  from { transform: translateY(0); }
  to { transform: translateY(100%); }
}
</style>
