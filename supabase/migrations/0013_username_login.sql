-- ============================================================================
-- LearnInText 迁移 0013：恢复「用户名登录」（用户名或邮箱 + 密码）
-- ============================================================================
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全部内容 → Run（手动执行）
--
-- 背景：
--   0012 将登录收紧为邮箱直登，收回了 resolve_login_identifier 的执行权限。
--   用户要求恢复用户名登录：客户端在输入不含 @ 时调用本 RPC，把用户名解析为
--   注册邮箱后再 signInWithPassword（Supabase Auth 仅支持邮箱登录，
--   用户名→邮箱解析是该场景的标准做法）。
--
-- 已知代价（与 0005~0011 时期的行为一致）：
--   * 该 RPC 以 anon 可调用，持有 anon key 者可按用户名探测/换取邮箱，
--     存在用户枚举与 PII 泄露面。缓解：仅 5 个管理员手动创建的账号、
--     用户名非公开分发；错误提示统一为「用户名或密码错误」，不区分
--     「用户不存在」；建议在 Dashboard → Authentication 保持开启
--     captcha / rate limit。
--   * username_exists（注册预检）保持下线，注册仍未开放。
--
-- 幂等：可重复执行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 重建「用户名→邮箱」解析 RPC（0012 后函数在部分环境可能已被基线 drop）
-- ----------------------------------------------------------------------------
create or replace function public.resolve_login_identifier(identifier text)
returns text
language sql
security definer
set search_path = public
as $$
  select case
    -- 参数是邮箱格式：直接用
    when identifier ~ '@' then identifier
    -- 否则按用户名查邮箱
    else (
      select email from public.profiles
      where username = resolve_login_identifier.identifier
        and email <> ''
      limit 1
    )
  end;
$$;

-- ----------------------------------------------------------------------------
-- 2. 授权：登录发生在认证之前，anon 必须可调用
-- ----------------------------------------------------------------------------
grant execute on function public.resolve_login_identifier(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. 执行后校验（只读查询，期望值见行尾注释）
-- ----------------------------------------------------------------------------
select
  has_function_privilege('anon', 'public.resolve_login_identifier(text)', 'EXECUTE')          as anon_resolve,     -- true
  has_function_privilege('authenticated', 'public.resolve_login_identifier(text)', 'EXECUTE') as auth_resolve,     -- true
  has_function_privilege('anon', 'public.username_exists(text)', 'EXECUTE')                   as anon_username_exists; -- false

-- ============================================================================
-- 回滚（如需恢复 0012 的邮箱直登状态）：
--   revoke execute on function public.resolve_login_identifier(text) from public, anon, authenticated;
-- ============================================================================
