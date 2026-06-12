-- Refresh de datos de mercado on-demand (botón en la app) + función de frescura.
-- El cron `mercado-refresh` (21:00 UTC) ya corre refresh_instrumentos(); esto agrega
-- un disparo manual y una vista de completitud por tipo (acciones/cedears/bonos/letras).

-- Frescura: última captura + cantidad de símbolos por tipo en su última fecha + fechas de
-- las demás series. STABLE + grant a anon => la app la consulta por GET /rpc/mercado_freshness
-- (sirve para mostrar "Datos al ..." y para el polling tras disparar el refresh).
create or replace function public.mercado_freshness()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with ult as (
    select tipo, max(fecha) as fecha from public.cotizaciones_mercado group by tipo
  ),
  cnt as (
    select c.tipo, u.fecha, count(distinct c.symbol) as symbols
    from public.cotizaciones_mercado c
    join ult u on u.tipo = c.tipo and c.fecha = u.fecha
    group by c.tipo, u.fecha
  )
  select jsonb_build_object(
    'ts', now(),
    'ultima_captura', (select max(captured_at) from public.cotizaciones_mercado),
    'mercado', coalesce((select jsonb_agg(jsonb_build_object('tipo', tipo, 'fecha', fecha, 'symbols', symbols) order by tipo) from cnt), '[]'::jsonb),
    'series', jsonb_build_object(
      'dolar',       (select max(fecha) from public.dolar),
      'plazo_fijo',  (select max(fecha) from public.plazo_fijo),
      'riesgo_pais', (select max(fecha) from public.riesgo_pais),
      'uva',         (select max(fecha) from public.uva),
      'cripto',      (select max(fecha) from public.rendimientos_cripto),
      'tasas',       (select max(fecha) from public.tasas_30dias),
      'inflacion',   (select max(fecha) from public.inflacion)
    )
  );
$$;
grant execute on function public.mercado_freshness() to anon, authenticated, service_role;

-- Wrapper para disparar el refresh desde la Edge Function (service_role vía PostgREST).
-- statement_timeout propio de 180s: evita que el límite de 8s del rol `authenticator`
-- (que usa PostgREST) corte la corrida, que tarda ~20-40s por los http_get sincrónicos.
create or replace function public.mercado_refresh_now()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
set statement_timeout = '180s'
as $$
begin
  return public.refresh_instrumentos();
end;
$$;
revoke all on function public.mercado_refresh_now() from anon, authenticated, public;
grant execute on function public.mercado_refresh_now() to service_role;
