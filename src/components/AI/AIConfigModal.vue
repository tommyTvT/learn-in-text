<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { fetchModels } from '../../services/ai'
import { X, Plus, Trash2, ChevronDown, Loader2, Eye, EyeOff, Bot, Check } from 'lucide-vue-next'

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  }
})
const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()
const activeProvider = computed(() => settingsStore.activeProvider)

// ---- API Key 显示/隐藏 ----
const showApiKey = ref(false)
const apiKeyFocused = ref(false)
const apiKeyShown = computed(() =>
  apiKeyFocused.value || showApiKey.value || !activeProvider.value?.apiKey
    ? (activeProvider.value?.apiKey || '')
    : '••••••••'
)
function onApiKeyInput(e) {
  if (activeProvider.value) {
    activeProvider.value.apiKey = e.target.value
  }
}

// ---- 供应商操作 ----
function handleAddProvider() {
  settingsStore.addCustomProvider()
}
function handleRemoveProvider(id) {
  const provider = settingsStore.providers.find(p => p.id === id)
  if (!confirm(`确定删除供应商「${provider?.name}」吗？其 API Key 配置将一并删除。`)) return
  settingsStore.removeProvider(id)
}

// ---- 模型列表自动获取 ----
const modelList = ref([])
const modelsLoading = ref(false)
const modelsError = ref('')
const modelDropdownOpen = ref(false)
const modelFilter = ref('')

const filteredModels = computed(() => {
  const keyword = modelFilter.value.trim().toLowerCase()
  if (!keyword) return modelList.value
  return modelList.value.filter(m => m.toLowerCase().includes(keyword))
})

async function handleFetchModels() {
  modelsLoading.value = true
  modelsError.value = ''
  modelList.value = []
  try {
    modelList.value = await fetchModels()
    if (!modelList.value.length) {
      modelsError.value = '该接口未返回可用模型列表，请手动填写模型名称'
    } else {
      modelFilter.value = ''
      modelDropdownOpen.value = true
    }
  } catch (error) {
    modelsError.value = '获取失败：' + error.message
  } finally {
    modelsLoading.value = false
  }
}

function onModelInput() {
  modelFilter.value = activeProvider.value?.model || ''
  if (modelList.value.length) {
    modelDropdownOpen.value = true
  }
}

function openModelDropdown() {
  if (!modelList.value.length) return
  modelFilter.value = ''
  modelDropdownOpen.value = true
}

function selectModel(model) {
  if (activeProvider.value) {
    activeProvider.value.model = model
  }
  modelDropdownOpen.value = false
}

function closeModelDropdown() {
  // 延迟关闭，让下拉项的点击事件先触发
  setTimeout(() => {
    modelDropdownOpen.value = false
  }, 150)
}

// 切换供应商时重置临时 UI 状态
watch(() => settingsStore.activeProviderId, () => {
  modelList.value = []
  modelsError.value = ''
  modelDropdownOpen.value = false
  modelFilter.value = ''
  showApiKey.value = false
})

// ---- 关闭处理 ----
function handleOverlayClick() {
  emit('close')
}
function handleEsc(e) {
  if (e.key === 'Escape' && props.open) {
    emit('close')
  }
}

watch(() => props.open, (val) => {
  if (val) {
    modelList.value = []
    modelsError.value = ''
    modelDropdownOpen.value = false
    modelFilter.value = ''
    showApiKey.value = false
  }
})

onMounted(() => window.addEventListener('keydown', handleEsc))
onBeforeUnmount(() => window.removeEventListener('keydown', handleEsc))
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
      <div
        v-if="open"
        class="fixed inset-0 z-50"
      >
      <!-- 全屏界面：从下到上滑入铺满屏幕 -->
      <div
        class="relative h-full w-full bg-white dark:bg-neutral-900 flex flex-col overflow-hidden"
      >
        <!-- 顶部安全区提示条（可选） -->
        <div class="sm:hidden pt-[env(safe-area-inset-top)] bg-white dark:bg-neutral-900"></div>

        <!-- 头部 -->
        <div class="relative flex items-center justify-center px-5 py-4 border-b border-gray-100 dark:border-neutral-800">
          <h2 class="text-base font-semibold text-gray-900 dark:text-neutral-100">AI 接口配置</h2>
          <button
            @click="emit('close')"
            class="absolute right-4 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X class="w-5 h-5" />
          </button>
        </div>

        <!-- 内容滚动区 -->
        <div class="flex-1 overflow-y-auto">
          <div class="max-w-2xl mx-auto w-full px-5 py-4 space-y-5">
          <!-- 供应商列表 -->
          <div class="anim-rise">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-medium text-gray-700 dark:text-neutral-300">供应商</h3>
              <span class="text-xs text-gray-400 dark:text-neutral-500">点击切换当前使用</span>
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              <div
                v-for="provider in settingsStore.providers"
                :key="provider.id"
                @click="settingsStore.setActiveProvider(provider.id)"
                :class="[
                  'relative cursor-pointer rounded-lg border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
                  settingsStore.activeProviderId === provider.id
                    ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200 shadow-sm dark:border-neutral-400 dark:bg-neutral-800 dark:ring-neutral-600'
                    : 'border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-gray-50 hover:border-blue-300 dark:hover:bg-neutral-800'
                ]"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-medium text-gray-900 dark:text-neutral-100 truncate flex items-center gap-1.5">
                    <Bot class="w-4 h-4 text-gray-400 dark:text-neutral-500 shrink-0" />
                    {{ provider.name }}
                  </span>
                  <span
                    :class="[
                      'shrink-0 text-xs px-2 py-0.5 rounded-full',
                      provider.apiKey
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                        : 'bg-gray-100 text-gray-500 dark:bg-neutral-700 dark:text-neutral-400'
                    ]"
                  >
                    {{ provider.apiKey ? '已配置' : '未配置 Key' }}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-2 mt-1">
                  <span class="text-xs text-gray-500 dark:text-neutral-400 truncate">
                    {{ provider.preset ? '预设 · ' : '' }}{{ provider.model || '未设置模型' }}
                  </span>
                  <Check
                    v-if="settingsStore.activeProviderId === provider.id"
                    class="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0"
                  />
                </div>
              </div>

              <button
                @click="handleAddProvider"
                class="rounded-lg border-2 border-dashed border-gray-300 dark:border-neutral-700 p-3 text-sm text-gray-500 dark:text-neutral-400 hover:border-blue-400 hover:text-blue-600 dark:hover:border-neutral-500 dark:hover:text-neutral-200 transition-colors cursor-pointer"
              >
                <Plus class="w-4 h-4 inline-block mr-1 -mt-0.5" />
                添加自定义供应商
              </button>
            </div>
          </div>

          <!-- 当前供应商配置 -->
          <div v-if="activeProvider" class="anim-rise anim-rise-delay border-t border-gray-200 dark:border-neutral-800 pt-4 space-y-4">
            <div v-if="activeProvider.preset" class="bg-gray-50 dark:bg-neutral-800 rounded-md p-3 text-sm text-gray-600 dark:text-neutral-400">
              接口地址：<span class="font-medium text-gray-900 dark:text-neutral-100">{{ activeProvider.endpoint }}</span>
            </div>

            <template v-if="!activeProvider.preset">
              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">供应商名称</label>
                <input
                  v-model="activeProvider.name"
                  type="text"
                  placeholder="例如：我的 OpenAI"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">API 端点</label>
                <input
                  v-model="activeProvider.endpoint"
                  type="text"
                  placeholder="https://api.openai.com/v1"
                  class="w-full px-3 py-2 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                />
                <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                  OpenAI兼容接口地址，例如：https://api.openai.com/v1
                </p>
              </div>
            </template>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">API Key</label>
              <!-- 不使用密码输入框：部分手机的安全输入法无法粘贴，改用 text 输入框 + 隐藏时用点号遮挡 -->
              <div class="relative">
                <input
                  :value="apiKeyShown"
                  @input="onApiKeyInput"
                  @focus="apiKeyFocused = true"
                  @blur="apiKeyFocused = false"
                  type="text"
                  placeholder="sk-..."
                  class="w-full px-3 py-2 pr-12 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                />
                <button
                  @click="showApiKey = !showApiKey"
                  class="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-sm text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 transition-colors cursor-pointer"
                >
                  <component :is="showApiKey ? EyeOff : Eye" class="w-4 h-4" />
                </button>
              </div>
              <p v-if="activeProvider.preset" class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                预设供应商只需填写 API Key，接口地址已自动配置，模型可使用默认值或自行修改
              </p>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-1">模型</label>
              <div class="flex gap-2">
                <div class="relative flex-1">
                  <input
                    v-model="activeProvider.model"
                    @input="onModelInput"
                    @focus="openModelDropdown"
                    @blur="closeModelDropdown"
                    @keydown.esc="modelDropdownOpen = false"
                    type="text"
                    placeholder="gpt-3.5-turbo"
                    class="w-full px-3 py-2 pr-8 border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                  />
                  <button
                    v-if="modelList.length"
                    @mousedown.prevent="modelDropdownOpen = !modelDropdownOpen"
                    type="button"
                    class="absolute right-2 top-1/2 -translate-y-1/2 px-1 text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 cursor-pointer"
                  >
                    <ChevronDown :class="['w-4 h-4 transition-transform', modelDropdownOpen ? 'rotate-180' : '']" />
                  </button>

                  <!-- 自定义模型下拉面板 -->
                  <div
                    v-if="modelDropdownOpen && modelList.length"
                    class="absolute z-20 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg"
                  >
                    <div class="sticky top-0 px-3 py-1.5 text-xs text-gray-400 dark:text-neutral-500 bg-gray-50 dark:bg-neutral-800 border-b border-gray-100 dark:border-neutral-700">
                      共 {{ filteredModels.length }} 个模型{{ modelFilter ? '（已过滤）' : '' }}
                    </div>
                    <button
                      v-for="m in filteredModels"
                      :key="m"
                      @mousedown.prevent="selectModel(m)"
                      type="button"
                      :class="[
                        'block w-full text-left px-3 py-2 text-sm truncate transition-colors cursor-pointer',
                        m === activeProvider.model
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
                  @click="handleFetchModels"
                  :disabled="modelsLoading || !activeProvider.endpoint || !activeProvider.apiKey"
                  class="shrink-0 px-3 py-2 text-sm bg-gray-100 dark:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  <Loader2 v-if="modelsLoading" class="w-4 h-4 inline-block mr-1 animate-spin -mt-0.5" />
                  {{ modelsLoading ? '获取中...' : '获取模型列表' }}
                </button>
              </div>
              <p class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                可手动填写，或点击「获取模型列表」从接口拉取可用模型后从下拉中选择
                <span v-if="modelList.length">（已获取 {{ modelList.length }} 个模型）</span>
              </p>
              <p v-if="modelsError" class="text-xs text-red-600 dark:text-red-400 mt-1">{{ modelsError }}</p>
            </div>

            <div v-if="!activeProvider.preset" class="flex justify-end">
              <button
                @click="handleRemoveProvider(activeProvider.id)"
                class="px-3 py-1.5 text-sm text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer inline-flex items-center gap-1"
              >
                <Trash2 class="w-4 h-4" />
                删除此供应商
              </button>
            </div>
          </div>
          </div>
        </div>

        <!-- 底部 -->
        <div class="anim-rise anim-rise-delay-2 px-5 py-4 border-t border-gray-100 dark:border-neutral-800 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <div class="max-w-2xl mx-auto">
            <button
              @click="emit('close')"
              class="w-full px-4 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium cursor-pointer"
            >
              完成
            </button>
            <p class="text-center text-xs text-gray-400 dark:text-neutral-500 mt-2">
              配置自动保存，关闭后可在设置页测试连接
            </p>
          </div>
        </div>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.anim-rise {
  animation: anim-rise 0.4s ease-out 0.05s both;
}
.anim-rise-delay {
  animation-delay: 0.12s;
}
.anim-rise-delay-2 {
  animation-delay: 0.18s;
}

@keyframes anim-rise {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>

<!-- Transition 进出动画需定义在全局样式，才能被 Vue 动态添加的类引用 -->
<style>
/* 遮罩：淡入 / 淡出 */
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

/* 主体：滑入 / 滑出 */
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
