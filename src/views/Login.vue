<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { validateLoginIdentifier, validatePassword, readableError } from '../services/auth'
import { getLocalDataStats, getLocalDataOwner, setLocalDataOwner } from '../services/localData'
import { pauseAutoSync, resumeAutoSync, syncAfterLogin } from '../services/autoSync'
import LocalDataModal from '../components/Common/LocalDataModal.vue'
import { User, Lock, LoaderCircle } from 'lucide-vue-next'

const auth = useAuthStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const showLocalDataModal = ref(false)
const localDataStats = ref(null)

function getRedirect() {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') ? target : '/'
}

async function onSubmit() {
  error.value = validateLoginIdentifier(username.value) || validatePassword(password.value)
  if (error.value) return

  loading.value = true
  try {
    await auth.login({ username: username.value.trim(), password: password.value })
    // IndexedDB 不分账号：本地残留其他账号/离线数据时，先让用户决定是否合并，再进入应用
    const stats = await getLocalDataStats()
    const hasData = stats.articles > 0 || stats.words > 0 || stats.wordMarks > 0
    if (hasData && getLocalDataOwner() !== auth.username) {
      // 决策前暂停后台自动同步，防止切前台/网络恢复触发的同步抢先把残留数据推给新账号
      pauseAutoSync()
      localDataStats.value = stats
      showLocalDataModal.value = true
      return
    }
    // 无学习数据冲突，但设置可能仍是其他账号的残留（如会话过期后换号）→
    // 先重置为默认，再拉取当前账号的云端设置，避免旧设置串库/回传
    if (getLocalDataOwner() !== auth.username) {
      await settingsStore.resetSettings()
    }
    setLocalDataOwner(auth.username)
    await auth.syncSettingsAfterLogin()
    // 登录后立即全量同步（拉取云端数据到本地），不等定时任务；失败不阻塞进入应用
    await syncAfterLogin()
    router.push(getRedirect())
  } catch (e) {
    error.value = readableError(e)
  } finally {
    loading.value = false
  }
}

function onLocalDataDone() {
  showLocalDataModal.value = false
  resumeAutoSync()
  router.push(getRedirect())
}

function onLocalDataCancel() {
  showLocalDataModal.value = false
  resumeAutoSync()
}

onMounted(() => {
  if (auth.isLoggedIn) {
    router.replace(getRedirect())
  }
})
</script>

<template>
  <div class="min-h-[70vh] flex items-center justify-center">
    <div class="w-full max-w-md px-4">
      <!-- 品牌区 -->
      <div class="text-center mb-6">
        <div class="mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-2xl shadow-lg shadow-blue-500/20 mb-3">
          📚
        </div>
        <h1 class="text-xl font-bold text-gray-900 dark:text-neutral-100">欢迎回来</h1>
        <p class="mt-2 text-sm text-gray-500 dark:text-neutral-400">登录后即可启用云同步，多设备学习</p>
      </div>

      <!-- 表单卡片 -->
      <div class="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-200 dark:border-neutral-800 p-5 sm:p-6">
        <form @submit.prevent="onSubmit" class="space-y-5">
          <div>
            <label for="username" class="block text-sm font-medium text-gray-700 dark:text-neutral-300">用户名或邮箱</label>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <User class="w-5 h-5" />
              </span>
              <input
                id="username"
                v-model="username"
                type="text"
                autocomplete="username"
                placeholder="输入用户名或邮箱"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label for="password" class="block text-sm font-medium text-gray-700 dark:text-neutral-300">密码</label>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Lock class="w-5 h-5" />
              </span>
              <input
                id="password"
                v-model="password"
                type="password"
                autocomplete="current-password"
                placeholder="输入密码"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

          <button
            type="submit"
            :disabled="loading"
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <LoaderCircle v-if="loading" class="w-5 h-5 animate-spin" />
            <template v-else>登 录</template>
          </button>
        </form>

        <p class="mt-5 text-center text-sm text-gray-500 dark:text-neutral-400">
          还没有账号？
          <RouterLink to="/register" class="text-blue-600 dark:text-blue-400 hover:underline">立即注册</RouterLink>
        </p>
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
