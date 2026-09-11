-- ============================================================================
-- LearnInText 云数据库迁移 0010：安全加固（DB-1 ~ DB-5）
-- ============================================================================
-- 内容（对应 docs/2026-08-11-bugfix-report.md「一、云端数据库修复」）：
--   DB-1 username 一旦设置即不可修改：prevent_username_change 触发器 + 重写 set_username
--   DB-2 handle_new_user 触发器加固：回收 EXECUTE、服务端格式校验、撞名报 username_already_taken
--   DB-3 删除冗余 RPC get_email_by_username（功能与 resolve_login_identifier 重复）
--   DB-4 RLS 策略性能修复：auth_username() / auth.uid() 包进 (select ...) 仅评估一次
--   DB-5 profiles.email 部分唯一索引（兼容空 email 行）
-- 两端契约错误码：username_already_taken（注册撞名）、username_immutable（改名被拒）。
-- 说明：开发阶段，允许删除历史数据。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- DB-1 username 不可变：触发器函数 + 触发器
--   允许 '' → 值（兼容 handle_new_user 回填与 set_username 首次设置），
--   其余对 username 的修改一律报 username_immutable；不拦截其他列更新。
-- ----------------------------------------------------------------------------
create or replace function public.prevent_username_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.username <> '' and new.username is distinct from old.username then
    raise exception 'username_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_username_immutable on public.profiles;
create trigger profiles_username_immutable
  before update on public.profiles
  for each row execute function public.prevent_username_change();

-- 重写 set_username：仅当前 username = '' 时允许设置；格式校验；成功返回 true
-- （原函数返回 void，返回值类型变更需先 drop 再建）
drop function if exists public.set_username(text);
create or replace function public.set_username(uname text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  cur_username text;
begin
  select username into cur_username
  from public.profiles
  where id = auth.uid();

  if cur_username is null then
    raise exception 'profile_not_found';
  end if;

  if cur_username <> '' then
    raise exception 'username_immutable';
  end if;

  if uname is null or uname !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'invalid_username_format';
  end if;

  update public.profiles
  set username = uname
  where id = auth.uid();

  return true;
end;
$$;

grant execute on function public.set_username(text) to authenticated;

-- ----------------------------------------------------------------------------
-- DB-2 handle_new_user 加固
--   * 回收 PUBLIC/anon/authenticated 的 EXECUTE（触发器触发不需要授权，不影响注册）
--   * 服务端校验 username 格式，非法按 null 处理（落库为 ''）
--   * 撞名时 raise exception 'username_already_taken'（前端映射为「该用户名已被占用」）
--   * 保留 on conflict (id) do update 回填逻辑（仅旧值为 '' 时回填 username）
-- ----------------------------------------------------------------------------
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta_username text := nullif(new.raw_user_meta_data ->> 'username', '');
begin
  -- 服务端格式校验：非法 username 按 null 处理（落库为 ''）
  if meta_username is not null and meta_username !~ '^[A-Za-z0-9_]{3,20}$' then
    meta_username := null;
  end if;

  -- 撞名检查：抛出契约错误码，供前端映射为友好提示
  if meta_username is not null
     and exists (select 1 from public.profiles where username = meta_username) then
    raise exception 'username_already_taken';
  end if;

  insert into public.profiles (id, email, username)
  values (new.id, coalesce(new.email, ''), coalesce(meta_username, ''))
  on conflict (id) do update
    set email = excluded.email,
        username = case
          -- 已绑定过业务用户名则不覆盖，避免误改
          when public.profiles.username = '' then excluded.username
          else public.profiles.username
        end;
  return new;
end;
$$;

-- 保留对 service_role 的授权（Auth 服务端触发路径使用）
grant execute on function public.handle_new_user() to service_role;

-- ----------------------------------------------------------------------------
-- DB-3 删除冗余 RPC get_email_by_username（登录走 resolve_login_identifier）
-- ----------------------------------------------------------------------------
drop function if exists public.get_email_by_username(text);

-- ----------------------------------------------------------------------------
-- DB-4 RLS 策略性能修复：函数调用包进 (select ...)，每语句仅评估一次
-- ----------------------------------------------------------------------------
drop policy if exists auth_user_access on public.articles;
create policy auth_user_access on public.articles
  for all to authenticated
  using (username = (select public.auth_username()))
  with check (username = (select public.auth_username()));

drop policy if exists auth_user_access on public.words;
create policy auth_user_access on public.words
  for all to authenticated
  using (username = (select public.auth_username()))
  with check (username = (select public.auth_username()));

drop policy if exists auth_user_access on public.word_marks;
create policy auth_user_access on public.word_marks
  for all to authenticated
  using (username = (select public.auth_username()))
  with check (username = (select public.auth_username()));

drop policy if exists auth_user_access on public.context_translations;
create policy auth_user_access on public.context_translations
  for all to authenticated
  using (username = (select public.auth_username()))
  with check (username = (select public.auth_username()));

drop policy if exists auth_user_access on public.user_settings;
create policy auth_user_access on public.user_settings
  for all to authenticated
  using (username = (select public.auth_username()))
  with check (username = (select public.auth_username()));

-- tombstones 表当前仅存在于本地 Dexie，云端尚无该表；条件执行保证迁移可重放
do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'tombstones'
  ) then
    drop policy if exists auth_user_access on public.tombstones;
    create policy auth_user_access on public.tombstones
      for all to authenticated
      using (username = (select public.auth_username()))
      with check (username = (select public.auth_username()));
  end if;
end;
$$;

-- profiles：select / update own profile 同样包 (select auth.uid())
drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select
  using ((select auth.uid()) = id);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- ----------------------------------------------------------------------------
-- DB-5 profiles.email 部分唯一索引（空 email 行不参与唯一约束）
-- 前置检查（应用前已执行）：select email, count(*) from public.profiles
--   where email <> '' group by email having count(*) > 1;  -- 结果为空方可应用
-- ----------------------------------------------------------------------------
create unique index if not exists profiles_email_unique
  on public.profiles (email)
  where email <> '';
