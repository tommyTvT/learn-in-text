<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { validateUsername, validateEmail, validatePassword, readableError } from '../services/auth'
import { User, Lock, Mail, LoaderCircle } from 'lucide-vue-next'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)
const needConfirm = ref(false)

function getRedirect() {
  const target = route.query.redirect
  return typeof target === 'string' && target.startsWith('/') ? target : '/'
}

async function onSubmit() {
  error.value =
    validateUsername(username.value) ||
    validateEmail(email.value) ||
    validatePassword(password.value)
  if (error.value) return
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }

  loading.value = true
  try {
    await auth.register({
      username: username.value.trim(),
      email: email.value.trim(),
      password: password.value
    })
    router.push(getRedirect())
  } catch (e) {
    if (e && e.message === 'NEED_EMAIL_CONFIRM') {
      needConfirm.value = true
    } else {
      error.value = readableError(e)
    }
  } finally {
    loading.value = false
  }
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
        <h1 class="text-xl font-bold text-gray-900 dark:text-neutral-100">创建账号</h1>
        <p class="mt-2 text-sm text-gray-500 dark:text-neutral-400">注册后可启用云同步，多设备学习</p>
      </div>

      <!-- 表单卡片 -->
      <div class="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl border border-gray-200 dark:border-neutral-800 p-5 sm:p-6">
        <form @submit.prevent="onSubmit" class="space-y-5">
          <div>
            <label for="username" class="block text-sm font-medium text-gray-700 dark:text-neutral-300">用户名</label>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <User class="w-5 h-5" />
              </span>
              <input
                id="username"
                v-model="username"
                type="text"
                autocomplete="username"
                placeholder="3-20 位字母、数字或下划线"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label for="email" class="block text-sm font-medium text-gray-700 dark:text-neutral-300">邮箱</label>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Mail class="w-5 h-5" />
              </span>
              <input
                id="email"
                v-model="email"
                type="email"
                autocomplete="email"
                placeholder="name@example.com"
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
                autocomplete="new-password"
                placeholder="至少 6 位"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label for="confirmPassword" class="block text-sm font-medium text-gray-700 dark:text-neutral-300">确认密码</label>
            <div class="relative mt-1">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
                <Lock class="w-5 h-5" />
              </span>
              <input
                id="confirmPassword"
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                placeholder="再次输入密码"
                class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-gray-300 dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800 text-gray-900 dark:text-neutral-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

          <div
            v-if="needConfirm"
            class="rounded-xl border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-700 dark:text-amber-300"
          >
            <p class="font-medium">✅ 注册成功！请完成邮箱验证</p>
            <p class="mt-1.5 leading-relaxed">
              我们已向 <span class="font-medium">{{ email }}</span> 发送了一封确认邮件，
              请前往邮箱查收并点击其中的验证链接。验证成功后即可用用户名或邮箱登录。
            </p>
            <p class="mt-1.5 text-xs opacity-80">未收到邮件？请检查垃圾箱，或稍后重试。</p>
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all cursor-pointer"
          >
            <LoaderCircle v-if="loading" class="w-5 h-5 animate-spin" />
            <template v-else>注 册</template>
          </button>
        </form>

        <p class="mt-5 text-center text-sm text-gray-500 dark:text-neutral-400">
          已有账号？
          <RouterLink to="/login" class="text-blue-600 dark:text-blue-400 hover:underline">去登录</RouterLink>
        </p>
      </div>
    </div>
  </div>
</template>
