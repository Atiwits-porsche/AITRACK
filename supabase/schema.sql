-- AITRACK schema for Supabase.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to run again (idempotent).

-- ---------- Transactions ----------
create table if not exists public.transactions (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id          text        not null,
  type        text        not null check (type in ('income', 'expense')),
  amount      numeric(14, 2) not null check (amount > 0),
  category_id text        not null default '',
  date        date        not null,
  note        text        not null default '' check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);

alter table public.transactions enable row level security;

drop policy if exists "transactions_select_own" on public.transactions;
drop policy if exists "transactions_insert_own" on public.transactions;
drop policy if exists "transactions_update_own" on public.transactions;
drop policy if exists "transactions_delete_own" on public.transactions;

create policy "transactions_select_own" on public.transactions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "transactions_insert_own" on public.transactions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "transactions_update_own" on public.transactions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "transactions_delete_own" on public.transactions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- Per-user settings (categories + monthly budget) ----------
create table if not exists public.user_settings (
  user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  categories jsonb       not null,
  budget     numeric(14, 2) not null default 0 check (budget >= 0),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "settings_select_own" on public.user_settings;
drop policy if exists "settings_insert_own" on public.user_settings;
drop policy if exists "settings_update_own" on public.user_settings;
drop policy if exists "settings_delete_own" on public.user_settings;

create policy "settings_select_own" on public.user_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "settings_insert_own" on public.user_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "settings_update_own" on public.user_settings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "settings_delete_own" on public.user_settings
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------- Realtime: push changes to the user's other open devices ----------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'transactions') then
    alter publication supabase_realtime add table public.transactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'user_settings') then
    alter publication supabase_realtime add table public.user_settings;
  end if;
end $$;

-- ---------- v2 (safe to re-run): time of each entry + monthly plan ----------
alter table public.transactions add column if not exists time_of_day text not null default '';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_time_of_day_check') then
    alter table public.transactions
      add constraint transactions_time_of_day_check check (time_of_day = '' or time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  end if;
end $$;

-- Salary, fixed costs and per-category budgets: {"items": [{id, kind, categoryId, amount, label}]}
alter table public.user_settings add column if not exists plan jsonb not null default '{"items": []}'::jsonb;

-- Make the new columns visible to the API immediately.
notify pgrst, 'reload schema';
