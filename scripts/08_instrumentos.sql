-- ============ DOLAR (serie historica, todas las casas) ============
create table if not exists public.dolar (
  fecha       date not null,
  casa        text not null,
  compra      numeric,
  venta       numeric,
  captured_at timestamptz not null default now(),
  primary key (fecha, casa)
);
alter table public.dolar enable row level security;
drop policy if exists "dolar lectura publica" on public.dolar;
create policy "dolar lectura publica" on public.dolar for select to anon, authenticated using (true);
create index if not exists idx_dolar_casa_fecha on public.dolar(casa, fecha);

-- ============ PLAZO FIJO (snapshot diario por banco) ============
create table if not exists public.plazo_fijo (
  fecha           date not null,
  entidad         text not null,
  tna_clientes    numeric,   -- en %
  tna_no_clientes numeric,
  logo            text,
  enlace          text,
  captured_at     timestamptz not null default now(),
  primary key (fecha, entidad)
);
alter table public.plazo_fijo enable row level security;
drop policy if exists "plazo_fijo lectura publica" on public.plazo_fijo;
create policy "plazo_fijo lectura publica" on public.plazo_fijo for select to anon, authenticated using (true);

-- ============ RIESGO PAIS (serie) ============
create table if not exists public.riesgo_pais (
  fecha       date primary key,
  valor       numeric,
  captured_at timestamptz not null default now()
);
alter table public.riesgo_pais enable row level security;
drop policy if exists "riesgo_pais lectura publica" on public.riesgo_pais;
create policy "riesgo_pais lectura publica" on public.riesgo_pais for select to anon, authenticated using (true);

-- ============ LOADERS ============
create or replace function public.load_dolar()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','60000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/cotizaciones/dolares');
  if resp is null then raise exception 'dolar vacio'; end if;
  insert into public.dolar (fecha, casa, compra, venta)
  select (e->>'fecha')::date, e->>'casa', nullif(e->>'compra','')::numeric, nullif(e->>'venta','')::numeric
  from jsonb_array_elements(resp) e
  on conflict (fecha, casa) do update set compra=excluded.compra, venta=excluded.venta, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'filas_afectadas',v_cnt,'total',(select count(*) from public.dolar));
end; $$;
revoke execute on function public.load_dolar() from anon, authenticated, public;

create or replace function public.load_plazo_fijo()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/tasas/plazoFijo');
  if resp is null then raise exception 'plazo fijo vacio'; end if;
  insert into public.plazo_fijo (fecha, entidad, tna_clientes, tna_no_clientes, logo, enlace)
  select hoy, e->>'entidad',
         nullif(e->>'tnaClientes','')::numeric*100, nullif(e->>'tnaNoClientes','')::numeric*100,
         e->>'logo', e->>'enlace'
  from jsonb_array_elements(resp) e
  on conflict (fecha, entidad) do update set
    tna_clientes=excluded.tna_clientes, tna_no_clientes=excluded.tna_no_clientes, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'bancos',v_cnt,'fecha',hoy);
end; $$;
revoke execute on function public.load_plazo_fijo() from anon, authenticated, public;

create or replace function public.load_riesgo_pais()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais');
  if resp is null then raise exception 'riesgo pais vacio'; end if;
  insert into public.riesgo_pais (fecha, valor)
  select (e->>'fecha')::date, nullif(e->>'valor','')::numeric
  from jsonb_array_elements(resp) e
  on conflict (fecha) do update set valor=excluded.valor, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'ultimo',(select max(fecha) from public.riesgo_pais),
    'valor',(select valor from public.riesgo_pais order by fecha desc limit 1));
end; $$;
revoke execute on function public.load_riesgo_pais() from anon, authenticated, public;
