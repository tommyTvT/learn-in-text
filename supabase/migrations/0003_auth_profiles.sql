-- ============================================================================
-- LearnInText 云数据库迁移 0003：Supabase Auth 强认证改造
-- ============================================================================
-- 背景：从「x-sync-user 请求头自报身份」升级为「基于 Auth 用户（auth.uid()）的强认证」。
--   * 新增 profiles 表，把唯一 username 绑定到 auth.users.id；
--   * 业务表仍保留 username 字段（前端 sync.js 大量依赖，改动最小），
--     但 RLS 从「x-sync-user 请求头」改为「当前登录用户在 profiles 中的 username
--     必须等于行的 username」的强认证校验；
--   * 旧的手动 username 数据因不在 profiles 表中而不可见（等价忽略旧数据）。
-- 说明：开发阶段，允许删除历史数据；本迁移不改动业务表数据行。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. profiles 表：username 唯一绑定 auth.users.id
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null default '',
  email text not null default '',
  "createdAt" timestamptz not null default now()
);

create index if not exists idx_profiles_username on public.profiles (username);

-- ----------------------------------------------------------------------------
-- 2. 触发器：auth.users 创建时自动建空 profile（幂等）
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 3. RPC：注册后由当前登录用户设置用户名（唯一约束兜底冲突）
-- ----------------------------------------------------------------------------
create or replace function public.set_username(uname text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set username = set_username.uname
  where id = auth.uid()
    and auth.uid() is not null;
$$;

-- ----------------------------------------------------------------------------
-- 4. RPC：登录时按用户名解析邮箱（anon 可调用，仅返回单条邮箱）
-- ----------------------------------------------------------------------------
create or replace function public.get_email_by_username(uname text)
returns text
language sql
security definer
set search_path = public
as $$
  select email
  from public.profiles
  where username = get_email_by_username.uname
    and email <> ''
  limit 1;
$$;

-- 按用户名查询是否已存在（注册时校验用户名占用）
create or replace function public.username_exists(uname text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where username = username_exists.uname
  );
$$;

-- ----------------------------------------------------------------------------
-- 5. 业务表 RLS 升级为强认证
--    辅助函数：返回当前登录用户（auth.uid()）在 profiles 中绑定的 username
-- ----------------------------------------------------------------------------
create or replace function public.auth_username()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select username
  from public.profiles
  where id = auth.uid();
$$;

-- 供 anon/authenticated 调用 get_email_by_username / set_username / username_exists
grant execute on function public.get_email_by_username(text) to anon, authenticated;
grant execute on function public.set_username(text) to authenticated;
grant execute on function public.username_exists(text) to anon, authenticated;
grant execute on function public.auth_username() to authenticated;

-- 对 4 张业务表：删除旧策略，重建为 auth_username() 强认证
alter table public.articles enable row level security;
drop policy if exists "sync_user_access" on public.articles;
create policy "auth_user_access" on public.articles
  for all
  using (username = public.auth_username())
  with check (username = public.auth_username());

alter table public.words enable row level security;
drop policy if exists "sync_user_access" on public.words;
create policy "auth_user_access" on public.words
  for all
  using (username = public.auth_username())
  with check (username = public.auth_username());

alter table public.word_marks enable row level security;
drop policy if exists "sync_user_access" on public.word_marks;
create policy "auth_user_access" on public.word_marks
  for all
  using (username = public.auth_username())
  with check (username = public.auth_username());

alter table public.context_translations enable row level security;
drop policy if exists "sync_user_access" on public.context_translations;
create policy "auth_user_access" on public.context_translations
  for all
  using (username = public.auth_username())
  with check (username = public.auth_username());

-- ----------------------------------------------------------------------------
-- 6. 清理：删除不再使用的 sync_user() 函数
-- ----------------------------------------------------------------------------
drop function if exists public.sync_user();

-- ----------------------------------------------------------------------------
-- 7. 角色授权：anon 客户端保持对业务表与序列的读写（由 RLS 把关）
-- ----------------------------------------------------------------------------
grant select, insert, update, delete
  on public.articles, public.words, public.word_marks, public.context_translations
  to anon;

grant usage, select on sequence public.articles_id_seq to anon;
grant usage, select on sequence public.words_id_seq to anon;
grant usage, select on sequence public.word_marks_id_seq to anon;
grant usage, select on sequence public.context_translations_id_seq to anon;
