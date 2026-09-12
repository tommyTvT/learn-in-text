import { reactive } from 'vue'
import { onLoad, onShow } from '@dcloudio/uni-app'

// 原 vue-router 路径 → uni-app 页面路径 映射表
const PAGE_MAP: Record<string, string> = {
  '/': '/pages/home/home',
  '/new': '/pages/article/new-article',
  '/generate': '/pages/article/generate',
  '/vocabulary': '/pages/vocabulary/vocabulary',
  '/settings': '/pages/settings/settings',
  '/login': '/pages/auth/login',
  '/email-verified': '/pages/auth/email-verified',
}

// tab 语义页面（顶层切换）：用 reLaunch 清空页面栈，避免 navigateTo 叠栈
const LAUNCH_PAGES = ['/', '/vocabulary', '/settings']

/** 查询参数 / 路由参数（值来自页面 options，统一为字符串） */
type RouteQuery = Record<string, any>

/** 导航目标：字符串路径，或 { path, query } 对象 */
export type RouteTarget = string | { path: string; query?: RouteQuery }

/** 当前路由信息 */
export interface RouteState {
  path: string
  params: RouteQuery
  query: RouteQuery
}

/** uni 页面实例上本项目使用的字段（含运行时挂载的自定义字段） */
interface UniPageLike {
  route?: string
  __route__?: string
  /** usePageRoute 缓存的页面参数，onShow（返回页面）时恢复路由信息 */
  $pageOptions?: RouteQuery
}

// 当前页面路由信息（模块级响应式单例；每个页面 onLoad/onShow 时刷新为当前页面参数）
export const currentRoute = reactive<RouteState>({ path: '/', params: {}, query: {} })

/**
 * 将 vue-router 风格的目标（字符串或 { path, query } 对象）解析为 uni-app 页面 url。
 * 支持 /reader/:id 动态参数（转为 /pages/reader/reader?id=xx）。
 */
function resolveUrl(to: RouteTarget): string | null {
  let path: string
  let query: RouteQuery = {}
  if (typeof to === 'object' && to !== null) {
    path = to.path
    query = { ...(to.query || {}) }
  } else {
    path = to
  }
  let pagePath: string | undefined = PAGE_MAP[path]
  const params: RouteQuery = {}
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
export function navigate(to: RouteTarget, mode: 'push' | 'replace' = 'push'): Promise<unknown> {
  const url = resolveUrl(to)
  if (!url) {
    return Promise.reject(new Error('未知路由: ' + (typeof to === 'object' ? to?.path : to)))
  }
  const pagePath = url.split('?')[0]
  const rawPath = Object.keys(PAGE_MAP).find((k) => PAGE_MAP[k] === pagePath)
  const isLaunch = rawPath != null && LAUNCH_PAGES.includes(rawPath)
  const method: (options: {
    url: string
    success: (res?: any) => void
    fail: (err: unknown) => void
  }) => void =
    mode === 'replace'
      ? isLaunch
        ? uni.reLaunch
        : uni.redirectTo
      : isLaunch
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

/**
 * 返回上一页。
 * - 页面栈深度 > 1：直接 uni.navigateBack（保留来源页状态，不回退到 fallback）
 * - 栈深度为 1（新开标签、刷新、从外部链接直达）：没有上一页可退，
 *   用 fallback 目标 replace，避免用户被卡在当前页
 * 失败时同样兜底到 fallback，双保险。
 * 注意：不读 window.history.state —— 非 H5 端无 window，
 * 且 uni 的页面栈才是这里真实可信的“有没有上一页”依据。
 */
export function back(fallback: RouteTarget = '/'): Promise<unknown> {
  const pages = getCurrentPages()
  if (pages.length <= 1) {
    return navigate(fallback, 'replace')
  }
  return new Promise((resolve, reject) => {
    uni.navigateBack({
      delta: 1,
      success: resolve,
      fail: (err) => {
        console.error('[routerShim] 返回失败，回退到:', fallback, err)
        navigate(fallback, 'replace').then(resolve, () => reject(err))
      },
    })
  })
}

// vue-router 兼容 API：返回带 push/replace/back 的路由器对象
export function useRouter() {
  return {
    push: (to: RouteTarget) => navigate(to, 'push'),
    replace: (to: RouteTarget) => navigate(to, 'replace'),
    back: (fallback?: RouteTarget) => back(fallback),
  }
}

// vue-router 兼容 API：返回当前路由信息（响应式）
export function useRoute() {
  return currentRoute
}

// 将 uni 页面参数写入 currentRoute（按当前页面栈顶实例）
function applyPageRoute(page: UniPageLike | undefined, options: RouteQuery | undefined): void {
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
export function usePageRoute(): void {
  onLoad((options) => {
    const pages = getCurrentPages() as UniPageLike[]
    const page = pages[pages.length - 1]
    if (page) page.$pageOptions = options || {}
    applyPageRoute(page, options)
  })
  onShow(() => {
    const pages = getCurrentPages() as UniPageLike[]
    const page = pages[pages.length - 1]
    applyPageRoute(page, page ? page.$pageOptions : {})
  })
}
