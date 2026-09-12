<script setup>
import { ref, computed, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useDialogA11y } from '../../composables/useDialogA11y'
import { X, Plus, Trash2, Eye, EyeOff, Bot, Loader2, Check } from 'lucide-vue-next'
import { alert, confirmDialog } from '../../services/dialog'
import { fetchModels } from '../../services/ai'

const props = defineProps({
  open: {
    type: Boolean,
    default: false
  }
})
const emit = defineEmits(['close'])

const settingsStore = useSettingsStore()

// 当前选中编辑的供应商 id（仅用于本弹窗内的编辑定位，不影响模型配置）
const activeProviderId = ref('')

const activeProvider = computed(() =>
  settingsStore.providers.find(p => p.id === activeProviderId.value) || null
)

// ---- API Key 显示/隐藏 ----
const showApiKey = ref(false)
const apiKeyFocused = ref(false)
const apiKeyShown = computed(() =>
  apiKeyFocused.value || showApiKey.value || !activeProvider.value?.apiKey
    ? (activeProvider.value?.apiKey || '')
    : '••••••••'
)
function onApiKeyInput(e) {
  if (!activeProvider.value) return
  // uni-app 的 <input> 编译为 uni-input，标准化事件的取值路径是
  // e.detail.value（e.target.value 为 undefined，会把密钥写成 undefined，
  // 导致既不生效也无法持久化）；保留 target 回退以兼容原生事件场景
  activeProvider.value.apiKey = e.detail?.value ?? e.target?.value ?? ''
}

// ---- 供应商操作 ----
function handleAddProvider() {
  const provider = settingsStore.addCustomProvider()
  activeProviderId.value = provider.id
  showApiKey.value = false
}
async function handleRemoveProvider(id) {
  const provider = settingsStore.providers.find(p => p.id === id)
  if (!await confirmDialog(`确定删除供应商「${provider?.name}」吗？其 API Key 配置将一并删除。`)) return
  settingsStore.removeProvider(id)
  if (activeProviderId.value === id) {
    activeProviderId.value = settingsStore.providers[0]?.id || ''
  }
}

// ---- 模型暴露管理 ----
const allModels = ref([])
const modelsLoading = ref(false)
const modelsError = ref('')
const modelSearch = ref('')

/** 按搜索关键字过滤后的模型列表 */
const displayedModels = computed(() => {
  const keyword = modelSearch.value.trim().toLowerCase()
  if (!keyword) return allModels.value
  return allModels.value.filter(m => m.toLowerCase().includes(keyword))
})

async function handleFetchAllModels() {
  if (!activeProvider.value) return
  modelsLoading.value = true
  modelsError.value = ''
  allModels.value = []
  try {
    allModels.value = await fetchModels(activeProvider.value.id)
    if (!allModels.value.length) {
      modelsError.value = '该接口未返回可用模型列表'
    } else if (!Array.isArray(activeProvider.value.exposedModels)) {
      // 未配置（默认全部暴露）：拉取成功后初始化为全量数组，
      // 保证勾选交互面对的是真实响应式数组
      activeProvider.value.exposedModels = [...allModels.value]
    }
  } catch (error) {
    modelsError.value = '获取失败：' + error.message
  } finally {
    modelsLoading.value = false
  }
}

/** 当前供应商已暴露模型集合（undefined 表示未配置 = 全部暴露） */
const exposedSet = computed(() => {
  const list = activeProvider.value?.exposedModels
  if (!Array.isArray(list)) return null
  return new Set(list)
})

function isModelExposed(modelId) {
  if (exposedSet.value === null) return true
  return exposedSet.value.has(modelId)
}

function toggleModelExposure(modelId) {
  if (!activeProvider.value) return
  // 渲染前已保证 exposedModels 为数组（handleFetchAllModels 中初始化）
  if (!Array.isArray(activeProvider.value.exposedModels)) {
    activeProvider.value.exposedModels = allModels.value.filter(m => m !== modelId)
    return
  }
  const idx = activeProvider.value.exposedModels.indexOf(modelId)
  if (idx >= 0) {
    activeProvider.value.exposedModels.splice(idx, 1)
  } else {
    activeProvider.value.exposedModels.push(modelId)
  }
}

/** 批量操作作用于当前展示的模型（有搜索关键字时仅影响匹配项） */
function exposeAllModels() {
  if (!activeProvider.value) return
  // 未配置（全部暴露）时无需变更
  if (!Array.isArray(activeProvider.value.exposedModels)) return
  const set = new Set(activeProvider.value.exposedModels)
  for (const m of displayedModels.value) set.add(m)
  activeProvider.value.exposedModels = [...set]
}

function unexposeAllModels() {
  if (!activeProvider.value) return
  const remove = new Set(displayedModels.value)
  if (!Array.isArray(activeProvider.value.exposedModels)) {
    // 未配置（全部暴露）时取消：以全量列表排除当前展示项作为白名单
    activeProvider.value.exposedModels = allModels.value.filter(m => !remove.has(m))
    return
  }
  activeProvider.value.exposedModels = activeProvider.value.exposedModels.filter(m => !remove.has(m))
}

// 切换供应商时重置模型列表缓存
watch(activeProviderId, () => {
  allModels.value = []
  modelsError.value = ''
  modelSearch.value = ''
})

// ---- 关闭处理 ----
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

watch(() => props.open, (val) => {
  if (val) {
    activeProviderId.value = settingsStore.providers[0]?.id || ''
    showApiKey.value = false
  }
})

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
        <!-- 全屏界面：从下到上滑入铺满屏幕 -->
        <div
          ref="panelRef"
          role="dialog"
          aria-modal="true"
          aria-label="供应商管理"
          class="relative h-full w-full bg-white dark:bg-neutral-900 flex flex-col overflow-hidden"
        >
          <div class="sm:hidden pt-[env(safe-area-inset-top)] bg-white dark:bg-neutral-900"></div>

          <!-- 头部 -->
          <div class="relative flex items-center justify-center px-5 py-3 border-b border-gray-100 dark:border-neutral-800">
            <h2 class="text-base font-semibold text-gray-900 dark:text-neutral-100">供应商管理</h2>
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
                  <span class="text-xs text-gray-400 dark:text-neutral-500">点击选中后编辑</span>
                </div>
                <div class="grid gap-2 sm:grid-cols-2">
                  <div
                    v-for="provider in settingsStore.providers"
                    :key="provider.id"
                    @click="activeProviderId = provider.id"
                    :class="[
                      'relative cursor-pointer rounded-lg border p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md',
                      activeProviderId === provider.id
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
                        {{ provider.preset ? '预设 · ' : '' }}{{ provider.endpoint || '未设置接口地址' }}
                      </span>
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

              <!-- 当前选中供应商配置 -->
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
                      :aria-pressed="showApiKey"
                      :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
                    >
                      <component :is="showApiKey ? EyeOff : Eye" class="w-4 h-4" />
                    </button>
                  </div>
                  <p v-if="activeProvider.preset" class="text-xs text-gray-500 dark:text-neutral-400 mt-1">
                    预设供应商只需填写 API Key，接口地址已自动配置
                  </p>
                </div>

                <!-- 模型暴露管理 -->
                <div class="border-t border-gray-200 dark:border-neutral-800 pt-4">
                  <div class="flex items-center justify-between mb-1">
                    <label class="block text-sm font-medium text-gray-700 dark:text-neutral-300">暴露给用户的模型</label>
                    <button
                      @click="handleFetchAllModels"
                      :disabled="modelsLoading || !activeProvider.endpoint || !activeProvider.apiKey"
                      class="px-2.5 py-1 text-xs bg-gray-100 dark:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded-md hover:bg-gray-200 dark:hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer inline-flex items-center gap-1"
                    >
                      <Loader2 v-if="modelsLoading" class="w-3 h-3 animate-spin" />
                      {{ modelsLoading ? '获取中...' : '获取模型列表' }}
                    </button>
                  </div>
                  <p class="text-xs text-gray-500 dark:text-neutral-400 mb-2">
                    {{ activeProvider.exposedModels === undefined || activeProvider.exposedModels === null
                      ? '未配置勾选：当前所有模型均对用户可见'
                      : `已暴露 ${activeProvider.exposedModels.length} 个模型，用户仅能选择已勾选的模型` }}
                  </p>

                  <template v-if="allModels.length">
                    <input
                      v-model="modelSearch"
                      type="text"
                      placeholder="搜索模型名称..."
                      class="w-full px-3 py-1.5 mb-2 text-sm border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-neutral-500"
                    />
                    <div class="flex items-center justify-between gap-3 mb-2 text-xs">
                      <div class="flex items-center gap-3">
                        <button @click="exposeAllModels" class="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">{{ modelSearch.trim() ? '暴露匹配项' : '全部暴露' }}</button>
                        <button @click="unexposeAllModels" class="text-gray-500 dark:text-neutral-400 hover:underline cursor-pointer">{{ modelSearch.trim() ? '取消匹配项' : '全部取消' }}</button>
                      </div>
                      <span class="text-gray-400 dark:text-neutral-500">
                        {{ modelSearch.trim() ? `匹配 ${displayedModels.length} / ${allModels.length}` : `共 ${allModels.length}` }}
                      </span>
                    </div>
                    <div class="max-h-56 overflow-y-auto rounded-lg border border-gray-200 dark:border-neutral-700 divide-y divide-gray-100 dark:divide-neutral-800">
                      <!-- 不使用原生 checkbox：uni-app 会将其编译为 uni-input，
                           原生勾选行为失效；勾选状态完全由 exposedModels 派生 -->
                      <button
                        v-for="m in displayedModels"
                        :key="m"
                        type="button"
                        @click="toggleModelExposure(m)"
                        role="checkbox"
                        :aria-checked="isModelExposed(m)"
                        class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800"
                      >
                        <span
                          :class="[
                            'w-4 h-4 shrink-0 rounded border flex items-center justify-center transition-colors',
                            isModelExposed(m)
                              ? 'bg-blue-600 border-blue-600 text-white'
                              : 'bg-white dark:bg-neutral-700 border-gray-300 dark:border-neutral-600'
                          ]"
                        >
                          <Check v-if="isModelExposed(m)" class="w-3 h-3" />
                        </span>
                        <span class="truncate text-gray-800 dark:text-neutral-200">{{ m }}</span>
                      </button>
                      <div
                        v-if="!displayedModels.length"
                        class="px-3 py-3 text-sm text-gray-400 dark:text-neutral-500 text-center"
                      >
                        没有匹配「{{ modelSearch }}」的模型
                      </div>
                    </div>
                  </template>
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
          <div class="anim-rise anim-rise-delay-2 px-5 py-3 border-t border-gray-100 dark:border-neutral-800 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div class="max-w-2xl mx-auto">
              <button
                @click="emit('close')"
                class="w-full px-4 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-medium cursor-pointer"
              >
                完成
              </button>
              <p class="text-center text-xs text-gray-400 dark:text-neutral-500 mt-2">
                配置自动保存，模型请在设置页「文本模型 / 视觉模型」中分别选择
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
