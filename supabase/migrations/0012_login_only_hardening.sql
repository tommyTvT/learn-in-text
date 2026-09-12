-- ============================================================================
-- LearnInText 迁移 0012：登录收紧（测试阶段：关闭自助注册，仅手动建号用户可登录）
-- ============================================================================
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全部内容 → Run（手动执行）
--
-- 【安全边界承诺】
--   * 本文件只包含权限语句（DCL：GRANT / REVOKE）；
--   * 不包含任何 DDL：不改表结构、不加删列、不改索引、不改函数定义；
--   * 不包含任何 DML：不读取、不修改、不删除任何数据行；
--   * 全部语句幂等，可重复执行；每条变更均附带回滚语句（见文末注释）。
--
-- 背景：
--   1. 客户端已下线注册页与「用户名→邮箱」登录解析（登录改为邮箱直登）；
--   2. 原 `resolve_login_identifier` RPC 允许任何持有 anon key 的匿名调用者
--      按用户名换取任意用户邮箱（PII 泄露 + 用户枚举），随注册下线一并收回；
--   3. 原 `username_exists` RPC 仅供注册预检使用，注册下线后一并收回；
--   4. 收回 anon 对全部表的 DML 权限：客户端表操作始终以 authenticated 会话
--      进行（RLS 仍为第二道防线），匿名仅剩的表权限属于过度授予。
--
-- ⚠️ 配套控制台动作（本 SQL 无法替代，否则 API 层仍可直接调 /auth/v1/signup 注册）：
--   Dashboard → Authentication → Providers → Email → 关闭「Enable Email Signup」
--   （关闭后手动建号功能不受影响：控制台 Add user / Admin API 创建的用户仍可登录）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 下线注册预检 RPC（客户端已不再调用）
-- ----------------------------------------------------------------------------
revoke execute on function public.username_exists(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. 下线「用户名→邮箱」解析 RPC（登录已改邮箱直登；同时消除匿名邮箱泄露面）
--    如未来恢复「用户名登录」，重新授权即可：
--      grant execute on function public.resolve_login_identifier(text) to anon, authenticated;
-- ----------------------------------------------------------------------------
revoke execute on function public.resolve_login_identifier(text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. 收回匿名角色对全部表与序列的权限（不改数据与结构，仅权限）
--    客户端所有表读写均在登录后以 authenticated 角色完成，不受影响；
--    注册触发器 handle_new_user 为 security definer，由 Auth 服务端执行，不受影响。
-- ----------------------------------------------------------------------------
revoke select, insert, update, delete
  on public.articles, public.words, public.word_marks,
     public.context_translations, public.user_settings, public.profiles
  from anon;

revoke all
  on sequence public.articles_id_seq, public.words_id_seq,
     public.word_marks_id_seq, public.context_translations_id_seq,
     public.user_settings_id_seq
  from anon;

-- ----------------------------------------------------------------------------
-- 4. 敏感 RPC 仅登录用户可执行
--    set_username：手动建号用户首次登录绑定用户名仍可用（authenticated）；
--    auth_username：RLS 策略仅对 authenticated 评估，anon 无适用策略，收回安全；
--    handle_new_user：防御性再回收（注册触发由 Auth 服务端以 service_role 执行）。
-- ----------------------------------------------------------------------------
revoke execute on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated;

revoke execute on function public.auth_username() from public, anon;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

-- ----------------------------------------------------------------------------
-- 5. 执行后校验（只读查询，期望值见行尾注释）
-- ----------------------------------------------------------------------------
select
  has_function_privilege('anon', 'public.resolve_login_identifier(text)', 'EXECUTE') as anon_resolve,        -- false
  has_function_privilege('anon', 'public.username_exists(text)', 'EXECUTE')          as anon_username_exists, -- false
  has_function_privilege('anon', 'public.set_username(text)', 'EXECUTE')             as anon_set_username,    -- false
  has_function_privilege('authenticated', 'public.set_username(text)', 'EXECUTE')    as auth_set_username,    -- true
  has_table_privilege('anon', 'public.articles', 'SELECT')                           as anon_articles_select, -- false
  has_table_privilege('anon', 'public.profiles', 'SELECT')                           as anon_profiles_select, -- false
  has_table_privilege('authenticated', 'public.profiles', 'SELECT')                  as auth_profiles_select; -- true

-- ============================================================================
-- 回滚（如需恢复到执行前状态，逐条执行）：
--   grant execute on function public.resolve_login_identifier(text) to anon, authenticated;
--   grant execute on function public.username_exists(text) to anon, authenticated;
--   grant select, insert, update, delete
--     on public.articles, public.words, public.word_marks,
--        public.context_translations, public.user_settings, public.profiles
--     to anon;
--   grant all on sequence public.articles_id_seq, public.words_id_seq,
--     public.word_marks_id_seq, public.context_translations_id_seq,
--     public.user_settings_id_seq to anon;
--   grant execute on function public.auth_username() to anon;
-- ============================================================================
