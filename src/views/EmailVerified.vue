<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { handleEmailConfirmation, readableError } from '../services/auth'
import { LoaderCircle, CheckCircle2, XCircle } from 'lucide-vue-next'

const auth = useAuthStore()
const router = useRouter()

const status = ref('loading') // loading | success | error
const message = ref('')

onMounted(async () => {
  // 等待 Supabase 客户端从 URL 中捕获并完成会话处理
  await new Promise((r) => setTimeout(r, 300))
  try {
    const session = await handleEmailConfirmation()
    if (session) {
      // 已登录：恢复完整会话（用户信息 + 用户名 + 云端设置）并跳转首页
      await auth.restoreSession()
      status.value = 'success'
      message.value = '邮箱验证成功，正在进入...'
      setTimeout(() => router.replace('/'), 1200)
    } else {
      // 未捕获到 session：可能是验证链接已过期/重复点击，或令牌异常
      status.value = 'error'
      message.value = '未能检测到验证结果，请确认链接是否有效，或重新尝试登录。'
    }
  } catch (e) {
    status.value = 'error'
    message.value = readableError(e) || '验证失败，请重试。'
  }
})
</script>

<template>
  <div class="min-h-[70vh] flex items-center justify-center">
    <div class="w-full max-w-md px-4">
      <div class="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-200 dark:border-neutral-800 p-8 text-center">
        <!-- 加载中 -->
        <div v-if="status === 'loading'">
          <LoaderCircle class="w-14 h-14 mx-auto text-blue-500 animate-spin" />
          <h1 class="mt-4 text-xl font-bold text-gray-900 dark:text-neutral-100">正在验证邮箱...</h1>
        </div>

        <!-- 验证成功 -->
        <div v-else-if="status === 'success'">
          <CheckCircle2 class="w-14 h-14 mx-auto text-green-500" />
          <h1 class="mt-4 text-xl font-bold text-gray-900 dark:text-neutral-100">邮箱验证成功</h1>
          <p class="mt-2 text-sm text-gray-500 dark:text-neutral-400">{{ message }}</p>
        </div>

        <!-- 验证失败 -->
        <div v-else>
          <XCircle class="w-14 h-14 mx-auto text-red-500" />
          <h1 class="mt-4 text-xl font-bold text-gray-900 dark:text-neutral-100">邮箱验证未完成</h1>
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
  </div>
</template>
