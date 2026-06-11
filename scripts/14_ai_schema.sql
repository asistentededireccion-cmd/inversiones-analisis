-- Asesor IA "Montagne": usuarios (clave privada), consumo, cartera, conversaciones.
-- Aplicado vía mcp__supabase__apply_migration (name: ai_asesor_schema).
-- Acceso solo por service_role (Edge Functions portal / asesor-ia); RLS on sin políticas.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ai_usuarios (
  id          uuid primary key default gen_random_uuid(),
  nombre      text not null,
  clave_hash  text not null unique,                 -- sha256(clave) en hex; nunca en claro
  rol         text not null default 'inversor' check (rol in ('inversor','direccion')),
  limite_usd  numeric not null default 10,
  periodo     text not null default 'mensual' check (periodo in ('mensual','total')),
  activo      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.ai_conversaciones (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references public.ai_usuarios(id) on delete cascade,
  titulo      text,
  created_at  timestamptz not null default now()
);

create table if not exists public.ai_mensajes (
  id              bigint generated always as identity primary key,
  conversacion_id uuid not null references public.ai_conversaciones(id) on delete cascade,
  rol             text not null check (rol in ('user','assistant')),
  contenido       text not null,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ai_mensajes_conv on public.ai_mensajes(conversacion_id);

create table if not exists public.ai_uso (
  id                    bigint generated always as identity primary key,
  usuario_id            uuid not null references public.ai_usuarios(id) on delete cascade,
  conversacion_id       uuid references public.ai_conversaciones(id) on delete set null,
  fecha                 timestamptz not null default now(),
  modelo                text,
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  cache_creation_tokens integer not null default 0,
  cache_read_tokens     integer not null default 0,
  costo_usd             numeric not null default 0
);
create index if not exists idx_ai_uso_usuario_fecha on public.ai_uso(usuario_id, fecha);

create table if not exists public.ai_cartera (
  id              bigint generated always as identity primary key,
  usuario_id      uuid not null references public.ai_usuarios(id) on delete cascade,
  instrumento     text not null,
  tipo            text not null default 'otro'
                    check (tipo in ('money_market','plazo_fijo','bono','dolar','accion','cedear','cripto','otro')),
  monto           numeric,
  moneda          text not null default 'ARS' check (moneda in ('ARS','USD')),
  fecha_inicio    date,
  fecha_fin       date,
  rendimiento_pct numeric,
  activo          boolean not null default true,     -- posición vigente vs cerrada
  notas           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ai_cartera_usuario on public.ai_cartera(usuario_id);

alter table public.ai_usuarios       enable row level security;
alter table public.ai_conversaciones enable row level security;
alter table public.ai_mensajes       enable row level security;
alter table public.ai_uso            enable row level security;
alter table public.ai_cartera        enable row level security;

-- Consumo del período vigente por usuario (mes actual si periodo='mensual')
create or replace view public.ai_consumo_periodo
with (security_invoker = true) as
select
  u.id as usuario_id, u.nombre, u.rol, u.limite_usd, u.periodo, u.activo,
  coalesce(sum(x.costo_usd), 0) as consumo_usd,
  count(x.id) as requests
from public.ai_usuarios u
left join public.ai_uso x
  on x.usuario_id = u.id
 and (u.periodo = 'total' or x.fecha >= date_trunc('month', now()))
group by u.id, u.nombre, u.rol, u.limite_usd, u.periodo, u.activo;

revoke all on public.ai_consumo_periodo from anon, authenticated;

-- Helper para crear usuarios con la clave hasheada (la clave nunca se guarda en claro)
--   select public.ai_crear_usuario('Nombre', 'clave-secreta', 'inversor', 10, 'mensual');
create or replace function public.ai_crear_usuario(
  p_nombre text, p_clave text, p_rol text default 'inversor',
  p_limite numeric default 10, p_periodo text default 'mensual'
) returns uuid
language sql
security definer
set search_path = public, extensions
as $$
  insert into public.ai_usuarios (nombre, clave_hash, rol, limite_usd, periodo)
  values (p_nombre, encode(extensions.digest(p_clave, 'sha256'), 'hex'), p_rol, p_limite, p_periodo)
  returning id;
$$;
revoke all on function public.ai_crear_usuario(text,text,text,numeric,text) from anon, authenticated, public;
