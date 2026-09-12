<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter, usePageRoute } from '../../composables/routerShim'
import PageLayout from '../../components/Common/PageLayout.vue'
import ULink from '../../components/Common/ULink.vue'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { validateLoginIdentifier, validatePassword, readableError } from '../../services/auth'
import { getLocalDataStats, getLocalDataOwner, setLocalDataOwner, setOwnershipPending, clearOwnershipPending, getOwnershipPending } from '../../services/localData'
import { pauseAutoSync, resumeAutoSync, syncAfterLogin } from '../../services/autoSync'
import LocalDataModal from '../../components/Common/LocalDataModal.vue'
import { User, Lock, LoaderCircle } from 'lucide-vue-next'

const auth = useAuthStore()
const settingsStore = useSettingsStore()
usePageRoute()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const showLocalDataModal = ref(false)
const localDataStats = ref(null)
// 登录后同步进度（label + percent），登录点击到跳转期间展示
const progressLabel = ref('')
const progressPercent = ref(0)

// 登录态失效提示：长时间未登录 / 会话被撤销时，说明需要重新登录的原因，
// 并明确本地学习数据不受影响，避免用户误以为数据丢失
const sessionNotice = computed(() => (auth.needsLogin ? (auth.sessionError || '登录状态已过期，请重新登录') : ''))

function setProgress(label, percent) {
  progressLabel.value = label
  progressPercent.value = percent
}

function getRedirect() {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') ? target : '/'
}

async function onSubmit() {
  error.value = validateLoginIdentifier(username.value) || validatePassword(password.value)
  if (error.value) return

  // 登录请求期间就暂停后台自动同步：登录成功到归属检测完成之间存在窗口，
  // boot 定时器/切前台若恰好触发会把残留数据推给新账号
  pauseAutoSync()
  loading.value = true
  setProgress('正在登录…', 8)
  try {
    await auth.login({ username: username.value.trim(), password: password.value })
    // IndexedDB 不分账号：本地残留其他账号/离线数据时，先让用户决定是否合并，再进入应用
    const stats = await getLocalDataStats()
    const hasData = stats.articles > 0 || stats.words > 0 || stats.wordMarks > 0
    if (hasData && getLocalDataOwner() !== auth.username) {
      // 持久化「归属决策待定」标记：弹窗未决时用户关闭/刷新页面，
      // 该标记会在下次启动继续拦截后台自动同步，防止数据误推/误删
      setOwnershipPending(auth.username)
      localDataStats.value = stats
      showLocalDataModal.value = true
      return
    }
    await finishLoginWithoutConflict()
  } catch (e) {
    resumeAutoSync()
    error.value = readableError(e)
  } finally {
    loading.value = false
  }
}

/** 无数据冲突路径的收尾：重置残留设置 → 绑定归属 → 同步设置与数据 → 进入应用 */
async function finishLoginWithoutConflict() {
  // 无学习数据冲突，但设置可能仍是其他账号的残留（如会话过期后换号）→
  // 先重置为默认，再拉取当前账号的云端设置，避免旧设置串库/回传
  if (getLocalDataOwner() !== auth.username) {
    await settingsStore.resetSettings()
  }
  setLocalDataOwner(auth.username)
  clearOwnershipPending()
  setProgress('正在同步设置…', 15)
  await auth.syncSettingsAfterLogin()
  // 登录后立即全量同步（拉取云端数据到本地），不等定时任务；失败不阻塞进入应用
  await syncAfterLogin((p) => setProgress(p.label, Math.max(15, p.percent)))
  resumeAutoSync()
  router.push(getRedirect())
}

/** 恢复上次未完成的归属决策（弹窗期间关闭/刷新页面后重新进入本页） */
async function resumeOwnershipDecision() {
  const stats = await getLocalDataStats()
  const hasData = stats.articles > 0 || stats.words > 0 || stats.wordMarks > 0
  if (hasData && getLocalDataOwner() !== auth.username) {
    pauseAutoSync()
    localDataStats.value = stats
    showLocalDataModal.value = true
    return
  }
  // 数据已不存在或归属已一致（可能已在别处决策）：按无冲突路径收尾
  await finishLoginWithoutConflict()
}

function onLocalDataDone() {
  showLocalDataModal.value = false
  clearOwnershipPending()
  resumeAutoSync()
  router.push(getRedirect())
}

function onLocalDataCancel() {
  showLocalDataModal.value = false
  clearOwnershipPending()
  resumeAutoSync()
}

// 停留在登录页期间会话自动恢复（如网络恢复后 refresh token 刷新成功）：
// 直接进入应用，避免已经可以免密登录却还要用户手动输入密码
watch(() => auth.isLoggedIn, (loggedIn) => {
  if (!loggedIn || loading.value) return
  // 归属决策未完成时交给 resumeOwnershipDecision 处理，不在这里抢跳转
  if (getOwnershipPending()) return
  router.replace(getRedirect())
})

onMounted(() => {
  if (auth.isLoggedIn) {
    // 上次登录的归属决策未完成（弹窗期间离开页面）：继续决策而非直接进入
    if (getOwnershipPending() === auth.username && auth.username) {
      resumeOwnershipDecision()
      return
    }
    router.replace(getRedirect())
  }
})

// 兜底：弹窗未决就离开登录页时恢复自动同步（数据安全由
// runSync 的 pending 标记持续拦截，布局组件会把用户引导回本页完成决策）
onUnmounted(() => {
  resumeAutoSync()
})
</script>

<template>
  <PageLayout bare>
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
        <!-- 会话失效提示：说明为什么需要重新登录，并安抚数据安全 -->
        <div
          v-if="sessionNotice"
          class="mb-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
        >
          <span class="mt-0.5 shrink-0">⚠️</span>
          <span>{{ sessionNotice }}（本地学习数据仍然保留，登录后会自动同步）</span>
        </div>

        <div class="space-y-5">
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
                @confirm="onSubmit"
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
                @confirm="onSubmit"
                placeholder="输入密码"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

          <button
            type="button"
            @click="onSubmit"
            :disabled="loading"
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <LoaderCircle v-if="loading" class="w-5 h-5 animate-spin" />
            <template v-else>登 录</template>
          </button>

          <!-- 登录 / 同步进度条：告知登录后正在拉取云端数据，缓解等待感 -->
          <div v-if="loading && progressLabel" class="mt-4">
            <div class="flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400 mb-1.5">
              <span>{{ progressLabel }}</span>
              <span>{{ progressPercent }}%</span>
            </div>
            <div class="h-1.5 rounded-full bg-gray-200 dark:bg-neutral-700 overflow-hidden">
              <div
                class="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300 ease-out"
                :style="{ width: progressPercent + '%' }"
              />
            </div>
          </div>
        </div>

        <p class="mt-5 text-center text-sm text-gray-500 dark:text-neutral-400">
          还没有账号？
          <ULink to="/register" class="text-blue-600 dark:text-blue-400 hover:underline">立即注册</ULink>
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
  </PageLayout>
</template>
