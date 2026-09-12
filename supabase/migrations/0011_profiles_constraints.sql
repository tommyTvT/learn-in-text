-- ============================================================================
-- LearnInText 云数据库迁移 0011：profiles 约束与权限修复
-- ============================================================================
-- 背景（代码审查发现的两处数据库层缺陷）：
--   1. profiles.username 为表级 UNIQUE NOT NULL DEFAULT ''：
--      第二个「未绑定用户名」的注册（绕过客户端校验 / Dashboard 手工建号 /
--      邮箱验证流程异常）会因 '' 重复直接 duplicate key 报错，注册流程崩坏。
--      email 已在 0010 改为部分唯一索引，username 补齐同样处理。
--   2. authenticated 保留了对 profiles 的 UPDATE 权限：
--      username 不可变已由触发器保证，但 email 仍可被任意 authenticated
--      用户改成「未占用的他人邮箱」。抢占后受害者在注册时会因
--      profiles_email_unique 违约而完全无法注册（DoS），且改邮箱者
--      用用户名登录会解析到错误的邮箱。
--      email 的合法更新路径只有 handle_new_user 触发器（security definer，
--      以函数所有者身份执行，不受权限回收影响）。
-- 幂等：可重复执行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. username 唯一约束改为部分唯一索引：允许多个 '' （无用户名）行存在
-- ----------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_username_key;

create unique index if not exists profiles_username_unique
  on public.profiles (username)
  where username <> '';

-- ----------------------------------------------------------------------------
-- 2. 收回 authenticated 对 profiles 的直接 UPDATE 权限
--    （SELECT 保留，供 fetchUsername；username 设置走 set_username RPC，
--     email 同步走 handle_new_user 触发器，两者均为 security definer，不受影响）
-- ----------------------------------------------------------------------------
revoke update on public.profiles from authenticated;
