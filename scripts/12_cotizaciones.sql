-- Cotizaciones de mercado (acciones, CEDEARs, bonos, letras) desde data912.com
create table if not exists public.cotizaciones_mercado (
  fecha       date not null,
  tipo        text not null,   -- accion | cedear | bono | letra
  symbol      text not null,
  px_bid      numeric,
  px_ask      numeric,
  ultimo      numeric,
  pct_change  numeric,
  volumen     numeric,
  captured_at timestamptz not null default now(),
  primary key (fecha, tipo, symbol)
);
alter table public.cotizaciones_mercado enable row level security;
drop policy if exists "cotizaciones lectura publica" on public.cotizaciones_mercado;
create policy "cotizaciones lectura publica" on public.cotizaciones_mercado for select to anon, authenticated using (true);
create index if not exists idx_cotiz_tipo_fecha on public.cotizaciones_mercado(tipo, fecha);

create or replace function public.load_cotizaciones()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  hoy date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
  rec record; v_cnt int := 0; v_tmp int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
  for rec in select * from (values
      ('accion','https://data912.com/live/arg_stocks'),
      ('cedear','https://data912.com/live/arg_cedears'),
      ('bono',  'https://data912.com/live/arg_bonds'),
      ('letra', 'https://data912.com/live/arg_notes')
    ) as t(tipo,url)
  loop
    insert into public.cotizaciones_mercado (fecha,tipo,symbol,px_bid,px_ask,ultimo,pct_change,volumen)
    select hoy, rec.tipo, e->>'symbol',
      nullif(e->>'px_bid','')::numeric, nullif(e->>'px_ask','')::numeric,
      nullif(e->>'c','')::numeric, nullif(e->>'pct_change','')::numeric, nullif(e->>'v','')::numeric
    from http_get(rec.url) h, lateral jsonb_array_elements(h.content::jsonb) e
    on conflict (fecha,tipo,symbol) do update set
      px_bid=excluded.px_bid, px_ask=excluded.px_ask, ultimo=excluded.ultimo,
      pct_change=excluded.pct_change, volumen=excluded.volumen, captured_at=now();
    get diagnostics v_tmp = row_count; v_cnt := v_cnt + v_tmp;
  end loop;
  return jsonb_build_object('ok',true,'fecha',hoy,'filas',v_cnt);
end; $$;
revoke execute on function public.load_cotizaciones() from anon, authenticated, public;
