-- Card Scanner : stockage des sessions de scan par compte.
-- À coller dans Supabase › SQL Editor › New query, puis « Run ». Peut être relancé sans risque.

create table if not exists public.scan_sessions (
  id          text primary key,                         -- identifiant créé par l'application
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null default '',
  items       jsonb not null default '[]'::jsonb,       -- les cartes de la session
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false            -- suppression synchronisée entre appareils
);

create index if not exists scan_sessions_user_idx on public.scan_sessions (user_id, updated_at desc);

-- Chaque compte ne voit et ne modifie que ses propres sessions.
alter table public.scan_sessions enable row level security;

drop policy if exists "own sessions: read"   on public.scan_sessions;
drop policy if exists "own sessions: insert" on public.scan_sessions;
drop policy if exists "own sessions: update" on public.scan_sessions;
drop policy if exists "own sessions: delete" on public.scan_sessions;

create policy "own sessions: read"   on public.scan_sessions for select using (auth.uid() = user_id);
create policy "own sessions: insert" on public.scan_sessions for insert with check (auth.uid() = user_id);
create policy "own sessions: update" on public.scan_sessions for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own sessions: delete" on public.scan_sessions for delete using (auth.uid() = user_id);

-- Les nouveaux projets Supabase n'ouvrent plus les tables d'office : seuls les comptes connectés y ont accès.
grant select, insert, update, delete on public.scan_sessions to authenticated;
revoke all on public.scan_sessions from anon;
