-- ============================================================================
-- LearnInText 云数据库迁移 0005：支持邮箱确认（Confirm email）流程
-- ============================================================================
-- 背景：项目启用「Confirm email」。注册时 signUp 不返回 session（auth.uid() 为空），
--   原 set_username（依赖 auth.uid()）无法写入用户名，导致 profiles.username 为空。
--   本迁移改为在 auth.users 创建触发器时直接从 raw_user_meta_data 读取用户名写入，
--   从而在邮箱确认前/后都能正确同步用户名。
-- 另：登录需同时支持「用户名」与「邮箱」，新增 resolve_login_identifier RPC。
-- 说明：开发阶段，允许删除历史数据。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 触发器：auth.users 创建时建 profile，并写入 meta 中的 username
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta_username text := nullif(new.raw_user_meta_data ->> 'username', '');
begin
  insert into public.profiles (id, email, username)
  values (new.id, coalesce(new.email, ''), coalesce(meta_username, ''))
  on conflict (id) do update
    set email = excluded.email,
        username = case
          -- 已绑定过业务用户名则不覆盖，避免误改
          when profiles.username = '' then excluded.username
          else profiles.username
        end;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. RPC：登录前按「用户名 或 邮箱」解析邮箱（anon 可调用）
--    返回匹配的邮箱；若参数本身是邮箱则原样返回。
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

grant execute on function public.resolve_login_identifier(text) to anon, authenticated;

-- 保持对旧 RPC 的授权（现有代码仍会用到，兼容）
grant execute on function public.set_username(text) to authenticated;
