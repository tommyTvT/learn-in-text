-- ============================================================================
-- LearnInText 云数据库迁移 0006：回填 profiles.username
-- ============================================================================
-- 说明：本文件为「按云端已应用迁移重建」版本（云端历史中存在 0006_backfill_username，
--   本地文件缺失，此处补齐以保持本地与云端迁移顺序一致、可顺序重放）。
-- 内容：对 username 为空串的 profile，从 auth.users 的 raw_user_meta_data 回填用户名。
-- 幂等：仅更新 username = '' 的行，可重复执行。
-- ============================================================================

update public.profiles p
set username = nullif(u.raw_user_meta_data ->> 'username', '')
from auth.users u
where u.id = p.id
  and p.username = ''
  and nullif(u.raw_user_meta_data ->> 'username', '') is not null;
