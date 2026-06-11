-- Rendimientos cripto (stablecoins en USD) desde argentinadatos
create table if not exists public.rendimientos_cripto (
  fecha       date not null,
  entidad     text not null,
  moneda      text not null,
  apy         numeric,
  captured_at timestamptz not null default now(),
  primary key (fecha, entidad, moneda)
);
alter table public.rendimientos_cripto enable row level security;
drop policy if exists "cripto lectura publica" on public.rendimientos_cripto;
create policy "cripto lectura publica" on public.rendimientos_cripto for select to anon, authenticated using (true);

create or replace function public.load_cripto()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/rendimientos');
  if resp is null then raise exception 'cripto vacio'; end if;
  insert into public.rendimientos_cripto (fecha, entidad, moneda, apy)
  select nullif(r->>'fecha','')::date, e->>'entidad', r->>'moneda', nullif(r->>'apy','')::numeric
  from jsonb_array_elements(resp) e, lateral jsonb_array_elements(e->'rendimientos') r
  where r->>'fecha' is not null
  on conflict (fecha, entidad, moneda) do update set apy=excluded.apy, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'filas_afectadas',v_cnt);
end; $$;
revoke execute on function public.load_cripto() from anon, authenticated, public;

-- Serie historica de tasa de plazo fijo 30 dias (para graficos del Historico)
create table if not exists public.tasas_30dias (
  fecha       date primary key,
  tna         numeric,   -- en %
  captured_at timestamptz not null default now()
);
alter table public.tasas_30dias enable row level security;
drop policy if exists "tasas30 lectura publica" on public.tasas_30dias;
create policy "tasas30 lectura publica" on public.tasas_30dias for select to anon, authenticated using (true);

create or replace function public.load_tasas_30dias()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/tasas/depositos30Dias');
  if resp is null then raise exception 'tasas30 vacio'; end if;
  insert into public.tasas_30dias (fecha, tna)
  select (e->>'fecha')::date, nullif(e->>'valor','')::numeric*100
  from jsonb_array_elements(resp) e
  on conflict (fecha) do update set tna=excluded.tna, captured_at=now();
  return jsonb_build_object('ok',true,'total',(select count(*) from public.tasas_30dias),
    'ultimo',(select max(fecha) from public.tasas_30dias),
    'tna_ultimo',(select tna from public.tasas_30dias order by fecha desc limit 1));
end; $$;
revoke execute on function public.load_tasas_30dias() from anon, authenticated, public;

-- Sumar todos los loaders nuevos al refresco diario
create or replace function public.refresh_instrumentos()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.load_dolar();
  perform public.load_plazo_fijo();
  perform public.load_riesgo_pais();
  perform public.load_uva();
  perform public.load_cotizaciones();
  perform public.load_cripto();
  perform public.load_tasas_30dias();
  return jsonb_build_object('ok', true, 'ts', now());
end; $$;
revoke execute on function public.refresh_instrumentos() from anon, authenticated, public;
