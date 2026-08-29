alter table public.profiles
  add column if not exists cafe_address text,
  add column if not exists open_hours text,
  add column if not exists shop_type text,
  add column if not exists barista_preferences text[] not null default '{}',
  add column if not exists bar_picture_url text;

comment on column public.profiles.cafe_address is 'Public-facing café street address.';
comment on column public.profiles.open_hours is 'Human-readable café opening hours.';
comment on column public.profiles.shop_type is 'Café format such as neighborhood café, bakery café, coffee bar, or roastery.';
comment on column public.profiles.barista_preferences is 'Checklist of qualities the café looks for in baristas.';
comment on column public.profiles.bar_picture_url is 'Optional public URL for a photo of the café bar or service area.';
