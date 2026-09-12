import { getSupabase } from '../lib/supabase'

/**
 * 认证 API 层：封装 Supabase Auth 与 username 映射。
 * 与 Pinia store 解耦，供 store 与视图直接调用。
 */

// 本地身份快照存储键：记录「最近一次确认过的登录身份」。
// access token 到期后需要联网刷新，若此时离线/网络抖动，会话会暂时读不出来，
// 但身份是已知的 —— 用快照避免「数据还在、却像没登录过」的错觉，
// 并让本地数据归属判断在离线状态下依然可用。
const IDENTITY_KEY = 'learn_in_text_auth_identity'

/** 持久化身份快照（登录/注册/会话恢复成功时调用） */
export function persistIdentity(user, username) {
  if (!user?.id) return
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({
      userId: user.id,
      username: username || '',
      email: user.email || '',
      at: Date.now()
    }))
  } catch {
    // 忽略存储异常
  }
}

/** 读取身份快照（无有效记录返回 null） */
export function readIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || !data.userId) return null
    return data
  } catch {
    return null
  }
}

/** 清除身份快照（仅在用户主动登出时调用；会话暂时失效不要清除） */
export function clearIdentity() {
  try {
    localStorage.removeItem(IDENTITY_KEY)
  } catch {
    // 忽略存储异常
  }
}

/**
 * 判断鉴权错误是否为「暂时性」的（重试可能成功）。
 * 暂时性错误说明本地会话仍然有效，只是这次读不到/刷新不了：
 * 网络不可达、请求超时、服务端 5xx、限流等。
 * 非暂时性（如 Invalid Refresh Token）表示会话已被云端撤销，只能重新登录。
 */
export function isRetryableAuthError(error) {
  if (!error) return false
  const status = Number(error.status)
  // auth-js 的网络类错误（AuthRetryableFetchError）status 为 0
  if (status === 0) return true
  if (Number.isFinite(status) && (status >= 500 || status === 429)) return true
  const text = `${error.name || ''} ${error.message || ''}`
  return /fetch|network|timeout|timed out|offline|load failed|failed to fetch/i.test(text)
}

/** 将后端错误转成用户可读的中文提示 */
export function readableError(error) {
  if (!error) return '未知错误'
  const msg = (error.message || '').toLowerCase()
  if (msg.includes('invalid login credentials')) return '用户名或密码错误'
  if (msg.includes('user already registered') || msg.includes('already registered')) return '该邮箱已被注册'
  if (msg.includes('email not confirmed')) return '邮箱尚未确认，请先完成邮箱验证'
  if (msg.includes('rate limit') || msg.includes('too many requests')) return '操作过于频繁，请稍后再试'
  if (msg.includes('username_already_taken')) return '该用户名已被占用'
  if (msg.includes('invalid refresh token') || msg.includes('refresh token')) return '登录状态已过期，请重新登录'
  if (msg.includes('auth session missing')) return '登录状态已失效，请重新登录'
  if (isRetryableAuthError(error)) return '网络连接不可用，请检查网络后重试'
  return error.message || '操作失败'
}

/** 校验并规范化用户名（仅允许字母数字下划线，长度 3-20） */
export function validateUsername(username) {
  const name = (username || '').trim()
  if (!name) return '请输入用户名'
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) {
    return '用户名需为 3-20 位字母、数字或下划线'
  }
  return ''
}

/** 校验邮箱格式 */
export function validateEmail(email) {
  const value = (email || '').trim()
  if (!value) return '请输入邮箱'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return '请输入有效的邮箱地址'
  return ''
}

/** 校验登录标识：允许「用户名」或「邮箱」，只需非空 */
export function validateLoginIdentifier(value) {
  const identifier = (value || '').trim()
  if (!identifier) return '请输入用户名或邮箱'
  return ''
}

/** 校验密码长度 */
export function validatePassword(password) {
  if (!password) return '请输入密码'
  if (password.length < 6) return '密码至少 6 位'
  return ''
}

/** 注册：创建 Auth 用户，用户名通过 raw_user_meta_data 传给触发器写入 profiles。
 * 邮箱确认开启时 signUp 返回空 session，需要引导用户完成邮箱验证。
 */
export async function register({ username, email, password }) {
  const supabase = getSupabase()

  // 先校验用户名是否已被占用（通过 RPC，非敏感泄露仅返回布尔）
  const { data: exists, error: existsError } = await supabase.rpc('username_exists', { uname: username })
  if (existsError) throw new Error(readableError(existsError))
  if (exists) throw new Error('该用户名已被占用')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      // 邮箱确认链接验证成功后跳转到结果页展示提示并自动登录
      // 注意：uni-app H5 端为 hash 路由，页面路径须带 # 前缀
      emailRedirectTo: origin ? `${origin}/#/email-verified` : undefined
    }
  })
  if (error) throw new Error(readableError(error))

  // 无需邮箱确认时 signUp 直接返回 session
  if (data.session) {
    return { session: data.session, user: data.user }
  }

  // 邮箱确认开启：返回标记，由调用方引导用户去邮箱确认
  throw new Error('NEED_EMAIL_CONFIRM')
}

/** 登录：支持「用户名」或「邮箱」两种标识 + 密码 */
export async function login({ username, password }) {
  const supabase = getSupabase()

  const { data: email, error: resolveError } = await supabase.rpc('resolve_login_identifier', { identifier: username })
  if (resolveError) throw new Error(readableError(resolveError))
  if (!email) throw new Error('用户名或邮箱不存在')

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(readableError(error))

  return { session: data.session, user: data.user }
}

/**
 * 处理邮箱确认/验证后的回调：
 * Supabase 确认邮件中的链接会带着令牌跳回站点，客户端在 URL 中检测 session。
 * 这里通过 getSession() 判断是否已确认成功，供验证结果页使用。
 */
export async function handleEmailConfirmation() {
  const supabase = getSupabase()
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(readableError(error))
  return data.session
}

/** 登出 */
export async function logout() {
  const supabase = getSupabase()
  const { error } = await supabase.auth.signOut()
  if (error) throw new Error(readableError(error))
}

/** 读取当前会话 */
export async function getSession() {
  const supabase = getSupabase()
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error(readableError(error))
  return data.session
}

/**
 * 安全读取当前会话：不抛异常，把「会话不存在」与「读取失败」区分开。
 * 返回 { session, error }：
 * - session 有值：正常；
 * - session 为 null 且 error 为可重试错误（isRetryableAuthError）：本地会话仍在，
 *   只是这次没刷新出来（离线/网络抖动/服务端故障），调用方应稍后重试而不是判定未登录；
 * - session 为 null 且 error 为空：本地确实没有会话（从未登录，或已被云端撤销并清理）。
 */
export async function loadSession() {
  let supabase
  try {
    supabase = getSupabase()
  } catch (error) {
    return { session: null, error }
  }
  try {
    const { data, error } = await supabase.auth.getSession()
    return { session: data?.session || null, error: error || null }
  } catch (error) {
    return { session: null, error }
  }
}

/**
 * 获取当前登录用户绑定在 profiles 中的用户名。
 * metadataUsername 来自 JWT 的 user_metadata（注册时写入），
 * 作为离线/请求失败时的回退值 —— 避免一次网络抖动就让应用「像没登录」。
 */
export async function fetchUsername(userId, metadataUsername = '') {
  if (!userId) return metadataUsername || ''
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle()
    if (error) return metadataUsername || ''
    return data?.username || metadataUsername || ''
  } catch {
    return metadataUsername || ''
  }
}
