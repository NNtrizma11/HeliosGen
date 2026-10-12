-- Run once in the Supabase SQL editor (already applied on the live project).
-- Records what Kie charged for each generation, for estimates and the Costs page.
alter table public.generations add column if not exists credits numeric;
alter table public.generations add column if not exists cost_key text;
alter table public.generations add column if not exists cost_units numeric;
create index if not exists generations_cost_key_idx on public.generations (cost_key, created_at desc) where credits is not null;
create index if not exists generations_created_at_idx on public.generations (created_at desc);
