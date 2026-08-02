-- Coreon preferences: one row per (user, tool). `state` holds the tool's
-- wizard blob (the same JSON currently kept in localStorage under
-- coreon-haul-state / coreon-runbook-state). New tools = new `key`, no schema
-- change needed.
--
-- Apply via Supabase dashboard → SQL Editor (paste + run), or the Supabase CLI.

create table if not exists public.preferences (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  key        text        not null,
  state      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- Row-Level Security: a user can only ever see or change their own rows.
alter table public.preferences enable row level security;

create policy "prefs_select_own" on public.preferences
  for select using (auth.uid() = user_id);

create policy "prefs_insert_own" on public.preferences
  for insert with check (auth.uid() = user_id);

create policy "prefs_update_own" on public.preferences
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "prefs_delete_own" on public.preferences
  for delete using (auth.uid() = user_id);
