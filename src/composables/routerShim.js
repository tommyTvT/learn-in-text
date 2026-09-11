import { reactive } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'

// 原 vue-router 路径 → uni-app 页面路径 映射表
const PAGE_MAP = {
  '/': '/pages/home/home',
  '/new': '/pages/article/new-article',
  '/generate': '/pages/article/generate',
  '/vocabulary': '/pages/vocabulary/vocabulary',
  '/settings': '/pages/settings/settings',
  '/login': '/pages/auth/login',
  '/register': '/pages/auth/register',
  '/email-verified': '/pages/auth/email-verified',
}

// tab 语义页面（顶层切换）：用 reLaunch 清空页面栈，避免 navigateTo 叠栈
const LAUNCH_PAGES = ['/', '/vocabulary', '/settings']
// bare 布局页面（登录/注册/邮箱验证）：push 时保留返回能力
const BARE_PAGES = ['/login', '/register', '/email-verified']

// 当前页面路由信息（模块级响应式单例；每个页面 onLoad/onShow 时刷新为当前页面参数）
export const currentRoute = reactive({ path: '/', params: {}, query: {} })

/**
 * 将 vue-router 风格的目标（字符串或 { path, query } 对象）解析为 uni-app 页面 url。
 * 支持 /reader/:id 动态参数（转为 /pages/reader/reader?id=xx）。
 */
function resolveUrl(to) {
  let path = to
  let query = {}
  if (typeof to === 'object' && to !== null) {
    path = to.path
    query = { ...(to.query || {}) }
  }
  let pagePath = PAGE_MAP[path]
  const params = {}
  if (!pagePath) {
    const m = path && path.match(/^\/reader\/([^/?]+)/)
    if (m) {
      pagePath = '/pages/reader/reader'
      params.id = decodeURIComponent(m[1])
    }
  }
  if (!pagePath) {
    console.warn('[routerShim] 未识别的路由路径:', path)
    return null
  }
  const qs = Object.entries({ ...params, ...query })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `${pagePath}?${qs}` : pagePath
}

/**
 * 执行导航。
 * - replace → 顶层页面用 reLaunch，其余 redirectTo
 * - push → 顶层 tab 页用 reLaunch（清栈防叠页），bare 页与下钻页用 navigateTo
 */
export function navigate(to, mode = 'push') {
  const url = resolveUrl(to)
  if (!url) {
    return Promise.reject(new Error('未知路由: ' + (typeof to === 'object' ? to?.path : to)))
  }
  const pagePath = url.split('?')[0]
  const rawPath = Object.keys(PAGE_MAP).find((k) => PAGE_MAP[k] === pagePath)
  const method =
    mode === 'replace'
      ? LAUNCH_PAGES.includes(rawPath)
        ? uni.reLaunch
        : uni.redirectTo
      : LAUNCH_PAGES.includes(rawPath)
        ? uni.reLaunch
        : uni.navigateTo
  return new Promise((resolve, reject) => {
    method({
      url,
      success: resolve,
      fail: (err) => {
        console.error('[routerShim] 导航失败:', url, err)
        reject(err)
      },
    })
  })
}

// vue-router 兼容 API：返回带 push/replace 的路由器对象
export function useRouter() {
  return {
    push: (to) => navigate(to, 'push'),
    replace: (to) => navigate(to, 'replace'),
  }
}

// vue-router 兼容 API：返回当前路由信息（响应式）
export function useRoute() {
  return currentRoute
}

// 将 uni 页面参数写入 currentRoute（按当前页面栈顶实例）
function applyPageRoute(page, options) {
  const uniPath = page ? '/' + (page.route || page.__route__ || '') : ''
  const entry = Object.entries(PAGE_MAP).find(([, v]) => v === uniPath)
  currentRoute.path = entry ? entry[0] : uniPath
  currentRoute.params = {}
  currentRoute.query = {}
  for (const [k, v] of Object.entries(options || {})) {
    if (k === 'id') currentRoute.params.id = v
    currentRoute.query[k] = v
  }
}

/**
 * 页面级组合函数：在页面 setup 中调用一次，
 * 自动注册 onLoad/onShow，维护 currentRoute（含返回时刷新）。
 * options 会缓存在页面实例上，onShow（如 navigateBack 返回）时恢复。
 */
export function usePageRoute() {
  onLoad((options) => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    if (page) page.$pageOptions = options || {}
    applyPageRoute(page, options)
  })
  onShow(() => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    applyPageRoute(page, page ? page.$pageOptions : {})
  })
}
