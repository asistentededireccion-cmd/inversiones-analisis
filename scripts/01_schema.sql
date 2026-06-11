-- Extensiones necesarias
create extension if not exists http      with schema extensions;
create extension if not exists pg_cron;

-- Snapshot: una fila por captura (idealmente una por cierre de mes)
create table if not exists public.cafci_snapshots (
  id                 bigint generated always as identity primary key,
  fecha_base         date        not null,
  generated_at       timestamptz,
  total_clases       integer,
  clases_guardadas   integer,
  periodos           jsonb,
  fechas_disponibles jsonb,
  source_url         text        not null default 'https://estadisticas.cafci.org.ar/v2/fondos-mercado-de-dinero.json',
  captured_at        timestamptz not null default now(),
  constraint cafci_snapshots_fecha_base_key unique (fecha_base)
);

create table if not exists public.cafci_fondos (
  id               bigint generated always as identity primary key,
  snapshot_id      bigint  not null references public.cafci_snapshots(id) on delete cascade,
  fecha_base       date    not null,
  clase_id         integer not null,
  fondo_id         integer,
  sociedad         text,
  moneda_id        integer,
  moneda_nombre    text,
  tipo_dinero      text,
  clase_nombre     text,
  fondo_nombre     text,
  fecha_valor      date,
  patrimonio_neto  numeric,
  valor_cuotaparte numeric,
  tna_dia          numeric, dir_dia    numeric,
  tna_7d           numeric, dir_7d     numeric,
  tna_mes_1        numeric, dir_mes_1  numeric,
  tna_90d          numeric, dir_90d    numeric,
  tna_180d         numeric, dir_180d   numeric,
  tna_12m          numeric, dir_12m    numeric,
  tna_ytd          numeric, dir_ytd    numeric,
  rendimientos     jsonb,
  constraint cafci_fondos_snapshot_clase_key unique (snapshot_id, clase_id)
);

create index if not exists idx_cafci_fondos_snapshot   on public.cafci_fondos(snapshot_id);
create index if not exists idx_cafci_fondos_fecha_base  on public.cafci_fondos(fecha_base);
create index if not exists idx_cafci_fondos_clase       on public.cafci_fondos(clase_id);
create index if not exists idx_cafci_fondos_moneda_tipo on public.cafci_fondos(moneda_nombre, tipo_dinero);

alter table public.cafci_snapshots enable row level security;
alter table public.cafci_fondos    enable row level security;

-- Vista de solo-lectura para el frontend: solo el snapshot mas reciente
drop view if exists public.cafci_fondos_latest;
create view public.cafci_fondos_latest as
select
  f.fondo_nombre, f.clase_nombre, f.sociedad, f.moneda_nombre, f.tipo_dinero,
  f.valor_cuotaparte, f.patrimonio_neto,
  f.tna_dia, f.dir_dia, f.tna_7d, f.dir_7d, f.tna_mes_1, f.dir_mes_1,
  f.tna_ytd, f.dir_ytd, f.fecha_base
from public.cafci_fondos f
join (select id from public.cafci_snapshots order by fecha_base desc limit 1) s
  on f.snapshot_id = s.id;

grant select on public.cafci_fondos_latest to anon, authenticated;
