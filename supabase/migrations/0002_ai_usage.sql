-- Per-user daily AI usage counter — the cost-control guardrail behind the
-- AI Haul endpoint (api/haul.js). One row per (user, UTC day).
--
-- Apply via Supabase dashboard → SQL Editor (paste + run), or the Supabase CLI.

create table if not exists public.ai_usage (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  day        date        not null default (now() at time zone 'utc')::date,
  count      int         not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Row-Level Security: a user may read their own usage (to show "N left today").
-- Writes never happen directly — only through bump_ai_usage() below.
alter table public.ai_usage enable row level security;

create policy "ai_usage_select_own" on public.ai_usage
  for select using (auth.uid() = user_id);

-- Atomically increment today's counter for the calling user and enforce the cap.
-- SECURITY DEFINER so it can write despite there being no user-facing write
-- policy; it still keys everything off auth.uid(), so a caller can only ever
-- bump their OWN row. Raises P0001 'rate_limited' when the cap is exceeded
-- (the increment is rolled back so an over-limit call can't keep climbing).
create or replace function public.bump_ai_usage(p_limit int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_day   date := (now() at time zone 'utc')::date;
  v_count int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;

  insert into public.ai_usage (user_id, day, count, updated_at)
    values (v_uid, v_day, 1, now())
  on conflict (user_id, day)
    do update set count = ai_usage.count + 1, updated_at = now()
  returning count into v_count;

  if v_count > p_limit then
    update public.ai_usage
      set count = count - 1, updated_at = now()
      where user_id = v_uid and day = v_day;
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;

  return v_count;
end;
$$;

-- Callable by signed-in users only.
revoke all on function public.bump_ai_usage(int) from public, anon;
grant execute on function public.bump_ai_usage(int) to authenticated;
