-- Run this once in Supabase Dashboard → SQL Editor.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  full_name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create table if not exists public.driver_records (
  id uuid primary key,
  driver_name text not null,
  vehicle_number text not null,
  medical_valid_date date not null,
  medical_expiry_date date not null,
  medical_verified boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists profiles_approval_status_idx on public.profiles(approval_status);
create index if not exists driver_records_created_at_idx on public.driver_records(created_at desc);

alter table public.profiles enable row level security;
alter table public.driver_records enable row level security;

-- The app uses the server-only service role for protected operations.
-- No public browser policy is added, so an anon key cannot read or write records.