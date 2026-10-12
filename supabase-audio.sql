-- Run this once in your Supabase SQL editor, after supabase-setup.sql.
-- Lets the generations table store voiceovers from the Voice node.

alter table public.generations
  drop constraint if exists generations_generation_type_check;

alter table public.generations
  add constraint generations_generation_type_check
  check (generation_type in ('image', 'video', 'audio'));

alter table public.generations
  add column if not exists audio_url text;
