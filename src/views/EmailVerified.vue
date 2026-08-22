<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { handleEmailConfirmation, readableError } from '../services/auth'
import { getLocalDataStats, getLocalDataOwner, setLocalDataOwner } from '../services/localData'
import { pauseAutoSync, resumeAutoSync } from '../services/autoSync'
import LocalDataModal from '../components/Common/LocalDataModal.vue'
import { LoaderCircle, CheckCircle2, XCircle } from 'lucide-vue-next'

const auth = useAuthStore()
const settingsStore = useSettingsStore()
const router = useRouter()

const status = ref('loading') // loading | success | error
const message = ref('')
const showLocalDataModal = ref(false)
const localDataStats = ref(null)

// 兜底跳转定时器句柄，卸载时需清理
let redirectTimer = null

onUnmounted(() => {
  if (redirectTimer) {
    clearTimeout(redirectTimer)
    redirectTimer = null
  }
  // 兜底：页面卸载时确保自动同步已恢复（弹窗未决策就离开的场景）
  resumeAutoSync()
})

function finishAndRedirect() {
  status.value = 'success'
  message.value = '邮箱验证成功，正在进入...'
  redirectTimer = setTimeout(() => router.replace('/'), 1200)
}

/** 本地数据归属决策：与登录页一致，残留其他账号/离线数据时先弹窗再进入 */
async function decideLocalDataOwnership() {
  const stats = await getLocalDataStats()
  const hasData = stats.articles > 0 || stats.words > 0 || stats.wordMarks > 0
  if (hasData && getLocalDataOwner() !== auth.username) {
    localDataStats.value = stats
    showLocalDataModal.value = true
    status.value = 'success'
    message.value = '邮箱验证成功'
    return // 暂不跳转，等用户在弹窗中决定如何处理本地数据
  }
  // 无学习数据冲突，但设置可能仍是其他账号的残留 → 先重置为默认，再拉云端设置
  if (getLocalDataOwner() !== auth.username) {
    await settingsStore.resetSettings()
  }
  setLocalDataOwner(auth.username)
  await auth.syncSettingsAfterLogin()
  resumeAutoSync()
  finishAndRedirect()
}

onMounted(async () => {
  // 验证即登录：在归属决策前暂停后台自动同步，防止启动/切前台触发的同步抢先推送残留数据
  pauseAutoSync()
  // 等待 Supabase 客户端从 URL 中捕获并完成会话处理
  await new Promise((r) => setTimeout(r, 300))
  try {
    const session = await handleEmailConfirmation()
    if (session) {
      // 只恢复会话（用户名），云端设置同步延后到归属决策之后
      await auth.syncFromSession(session)
      await decideLocalDataOwnership()
    } else {
      // 未捕获到 session：可能是验证链接已过期/重复点击，或令牌异常
      resumeAutoSync()
      status.value = 'error'
      message.value = '未能检测到验证结果，请确认链接是否有效，或重新尝试登录。'
    }
  } catch (e) {
    resumeAutoSync()
    status.value = 'error'
    message.value = readableError(e) || '验证失败，请重试。'
  }
})

function onLocalDataDone() {
  showLocalDataModal.value = false
  resumeAutoSync()
  finishAndRedirect()
}

function onLocalDataCancel() {
  showLocalDataModal.value = false
  resumeAutoSync()
  // 已取消登录（登出），停在验证结果页
}
</script>

<template>
  <div class="min-h-[70vh] flex items-center justify-center">
    <div class="w-full max-w-md px-4">
      <div class="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-200 dark:border-neutral-800 p-6 text-center">
        <!-- 加载中 -->
        <div v-if="status === 'loading'">
          <LoaderCircle class="w-14 h-14 mx-auto text-blue-500 animate-spin" />
          <h1 class="mt-4 text-lg font-bold text-gray-900 dark:text-neutral-100">正在验证邮箱...</h1>
        </div>

        <!-- 验证成功 -->
        <div v-else-if="status === 'success'">
          <CheckCircle2 class="w-14 h-14 mx-auto text-green-500" />
          <h1 class="mt-4 text-lg font-bold text-gray-900 dark:text-neutral-100">邮箱验证成功</h1>
          <p class="mt-2 text-sm text-gray-500 dark:text-neutral-400">{{ message }}</p>
        </div>

        <!-- 验证失败 -->
        <div v-else>
          <XCircle class="w-14 h-14 mx-auto text-red-500" />
          <h1 class="mt-4 text-lg font-bold text-gray-900 dark:text-neutral-100">邮箱验证未完成</h1>
          <p class="mt-2 text-sm text-gray-500 dark:text-neutral-400">{{ message }}</p>
          <router-link
            to="/login"
            class="mt-6 inline-block px-6 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium hover:from-blue-700 hover:to-indigo-700 transition-all cursor-pointer"
          >
            去登录
          </router-link>
        </div>
      </div>
    </div>

    <LocalDataModal
      v-if="showLocalDataModal && localDataStats"
      :open="true"
      :stats="localDataStats"
      @done="onLocalDataDone"
      @cancel="onLocalDataCancel"
    />
  </div>
</template>
