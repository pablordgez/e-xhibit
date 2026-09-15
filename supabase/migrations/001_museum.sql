-- Apply once in the Supabase SQL editor or with `supabase db push`.
create table public.museum_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner','editor')),
  created_at timestamptz not null default now()
);
create unique index museum_one_owner on public.museum_members (role) where role = 'owner';
create table public.museum_drafts (
  id boolean primary key default true check (id),
  document jsonb not null,
  revision integer not null default 0 check (revision >= 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create table public.museum_assets (
  id uuid primary key,
  asset jsonb not null,
  files jsonb not null,
  ready boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
alter table public.museum_members enable row level security;
alter table public.museum_drafts enable row level security;
alter table public.museum_assets enable row level security;
-- Clients cannot bypass Worker validation or revision preconditions through PostgREST.
-- The server-only service role performs writes after live membership validation.
revoke all on public.museum_members, public.museum_drafts, public.museum_assets from anon, authenticated;
grant select, insert, update, delete on public.museum_members, public.museum_drafts, public.museum_assets to service_role;
-- Create the owner in Authentication > Users, then run with that user's UUID:
-- insert into public.museum_members(user_id,email,role)
-- values ('OWNER_UUID','owner@example.com','owner');
