import { getSupabase } from '../lib/supabase'

/**
 * 认证 API 层：封装 Supabase Auth 与 username 映射。
 * 与 Pinia store 解耦，供 store 与视图直接调用。
 */

/** 将后端错误转成用户可读的中文提示 */
export function readableError(error) {
  if (!error) return '未知错误'
  const msg = (error.message || '').toLowerCase()
  if (msg.includes('invalid login credentials')) return '用户名或密码错误'
  if (msg.includes('user already registered') || msg.includes('already registered')) return '该邮箱已被注册'
  if (msg.includes('email not confirmed')) return '邮箱尚未确认，请先完成邮箱验证'
  if (msg.includes('rate limit') || msg.includes('too many requests')) return '操作过于频繁，请稍后再试'
  if (msg.includes('username_already_taken')) return '该用户名已被占用'
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
      emailRedirectTo: origin ? `${origin}/email-verified` : undefined
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

/** 获取当前登录用户绑定在 profiles 中的用户名 */
export async function fetchUsername(userId) {
  if (!userId) return ''
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .maybeSingle()
  if (error) return ''
  return data?.username || ''
}
