-- Asesor IA — memoria del inversor (perfil persistente) y tracking de recomendaciones.
-- Acceso solo por service_role (Edge Functions portal / asesor-ia); RLS on sin políticas,
-- igual que el resto del esquema ai_* (ver 14_ai_schema.sql).

-- Perfil: una fila por usuario. El agente lo lee al inicio (memoria entre conversaciones)
-- y lo actualiza con la herramienta guardar_perfil cuando el inversor aporta datos.
create table if not exists public.ai_perfil (
  usuario_id       uuid primary key references public.ai_usuarios(id) on delete cascade,
  monto_disponible numeric,
  moneda           text check (moneda in ('ARS','USD')),
  horizonte        text check (horizonte in ('corto','medio','largo')),
  tolerancia       text check (tolerancia in ('conservador','moderado','agresivo')),
  objetivo         text,
  notas            text,
  updated_at       timestamptz not null default now()
);
alter table public.ai_perfil enable row level security;

-- Recomendaciones que el agente registra para luego medir su acierto.
-- Para instrumentos de mercado guardar el SYMBOL en `instrumento` (ej. 'GGAL') para que
-- la vista de seguimiento pueda cruzar contra el precio actual.
create table if not exists public.ai_recomendaciones (
  id              bigint generated always as identity primary key,
  usuario_id      uuid not null references public.ai_usuarios(id) on delete cascade,
  conversacion_id uuid references public.ai_conversaciones(id) on delete set null,
  instrumento     text not null,
  tipo            text not null default 'otro'
                    check (tipo in ('money_market','plazo_fijo','bono','dolar','accion','cedear','cripto','otro')),
  precio_ref      numeric,                     -- precio/valor al momento de recomendar
  fecha           date not null default current_date,
  horizonte       text check (horizonte in ('corto','medio','largo')),
  tesis           text,                        -- por qué se recomendó
  created_at      timestamptz not null default now()
);
create index if not exists idx_ai_recos_usuario on public.ai_recomendaciones(usuario_id, fecha desc);
alter table public.ai_recomendaciones enable row level security;

-- Defensa en profundidad: además de RLS sin políticas, revocamos los grants por defecto del
-- schema public para que anon/authenticated no tengan acceso aunque RLS llegara a desactivarse.
-- service_role ignora RLS y grants, así que las Edge Functions siguen operando.
revoke all on public.ai_perfil         from anon, authenticated;
revoke all on public.ai_recomendaciones from anon, authenticated;

-- Seguimiento: rendimiento de cada recomendación de mercado desde que se emitió.
-- security_invoker + revoke => solo service_role (caller sin políticas no ve nada).
create or replace view public.ai_recomendaciones_seguimiento
with (security_invoker = true) as
select
  rec.id, rec.usuario_id, rec.conversacion_id,
  rec.instrumento, rec.tipo, rec.precio_ref, rec.fecha, rec.horizonte, rec.tesis,
  m.px as px_actual, m.fecha as px_fecha,
  case when rec.precio_ref is not null and rec.precio_ref > 0 and m.px is not null
       then round((m.px / rec.precio_ref - 1) * 100, 1) end as var_desde_reco_pct,
  m.real_12m_pct, m.vol_anual_pct
from public.ai_recomendaciones rec
left join public.instrumento_metricas m
  on m.symbol = upper(rec.instrumento) and m.tipo = rec.tipo;

revoke all on public.ai_recomendaciones_seguimiento from anon, authenticated;
