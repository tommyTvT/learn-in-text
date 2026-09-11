-- ============================================================================
-- LearnInText 云数据库迁移 0002：软删除列 + 标记/翻译表补 updatedAt
-- ============================================================================
-- 执行方式：Supabase Dashboard → SQL Editor → New query → 粘贴本文件全部内容 → Run
-- 本迁移幂等，可重复执行；不会删除已有数据。
--
-- 背景：云端同步从「全量覆盖推/拉」升级为「双向差异合并（LWW）」：
--   * articles / words 已有 updatedAt，作为冲突解决的比较依据；
--   * word_marks / context_translations 此前只有 createdAt，缺少更新依据，补 updatedAt；
--   * 4 张表统一补 deletedAt（软删除），用于删除传播（本地 tombstone → 云端软删），
--     同时避免「本地删除后又被另一台设备拉回复活」。
-- ============================================================================

-- 软删除列（可为空 = 未删除）
alter table public.articles add column if not exists "deletedAt" timestamptz;
alter table public.words add column if not exists "deletedAt" timestamptz;
alter table public.word_marks add column if not exists "deletedAt" timestamptz;
alter table public.context_translations add column if not exists "deletedAt" timestamptz;

-- 标记 / 翻译表补齐更新依据列（存量行回填为 createdAt）
alter table public.word_marks add column if not exists "updatedAt" timestamptz;
update public.word_marks set "updatedAt" = "createdAt" where "updatedAt" is null;
alter table public.word_marks alter column "updatedAt" set default now();
alter table public.word_marks alter column "updatedAt" set not null;

alter table public.context_translations add column if not exists "updatedAt" timestamptz;
update public.context_translations set "updatedAt" = "createdAt" where "updatedAt" is null;
alter table public.context_translations alter column "updatedAt" set default now();
alter table public.context_translations alter column "updatedAt" set not null;
