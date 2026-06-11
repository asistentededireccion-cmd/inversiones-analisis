create or replace function public.cafci_load_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url  text := 'https://estadisticas.cafci.org.ar/v2/fondos-mercado-de-dinero.json';
  resp   jsonb;
  v_snap bigint;
  v_cnt  int;
begin
  -- timeout generoso para la descarga (~244 KB)
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');

  select content::jsonb into resp
  from http_get(v_url);

  if resp is null or resp->'clases' is null then
    raise exception 'Respuesta CAFCI invalida o vacia';
  end if;

  -- Snapshot (idempotente por fecha_base)
  insert into public.cafci_snapshots
    (fecha_base, generated_at, total_clases, clases_guardadas, periodos, fechas_disponibles, source_url, captured_at)
  values (
    (resp->>'fecha_base')::date,
    (resp->>'generated_at')::timestamptz,
    nullif(resp->>'total_clases','')::int,
    jsonb_array_length(resp->'clases'),
    resp->'periodos',
    resp->'fechas_disponibles',
    v_url,
    now()
  )
  on conflict (fecha_base) do update set
    generated_at     = excluded.generated_at,
    total_clases     = excluded.total_clases,
    clases_guardadas = excluded.clases_guardadas,
    periodos         = excluded.periodos,
    fechas_disponibles = excluded.fechas_disponibles,
    captured_at      = now()
  returning id into v_snap;

  -- Reemplazar detalle del snapshot (re-corridas idempotentes)
  delete from public.cafci_fondos where snapshot_id = v_snap;

  insert into public.cafci_fondos (
    snapshot_id, fecha_base, clase_id, fondo_id, sociedad, moneda_id, moneda_nombre,
    tipo_dinero, clase_nombre, fondo_nombre, fecha_valor, patrimonio_neto, valor_cuotaparte,
    tna_dia, dir_dia, tna_7d, dir_7d, tna_mes_1, dir_mes_1, tna_90d, dir_90d,
    tna_180d, dir_180d, tna_12m, dir_12m, tna_ytd, dir_ytd, rendimientos
  )
  select
    v_snap,
    (resp->>'fecha_base')::date,
    (c->>'clase_id')::int,
    nullif(c->>'fondo_id','')::int,
    c->>'sociedad',
    nullif(c->>'moneda_id','')::int,
    c->>'moneda_nombre',
    c->>'tipo_dinero',
    c->>'clase_nombre',
    c->>'fondo_nombre',
    nullif(c->>'fecha_valor','')::date,
    nullif(c->>'patrimonio_neto','')::numeric,
    nullif(c->>'valor_cuotaparte','')::numeric,
    nullif(c#>>'{rendimientos,dia,tna}','')::numeric,
    nullif(c#>>'{rendimientos,dia,directo}','')::numeric,
    nullif(c#>>'{rendimientos,dias_7,tna}','')::numeric,
    nullif(c#>>'{rendimientos,dias_7,directo}','')::numeric,
    nullif(c#>>'{rendimientos,mes_1,tna}','')::numeric,
    nullif(c#>>'{rendimientos,mes_1,directo}','')::numeric,
    nullif(c#>>'{rendimientos,dias_90,tna}','')::numeric,
    nullif(c#>>'{rendimientos,dias_90,directo}','')::numeric,
    nullif(c#>>'{rendimientos,dias_180,tna}','')::numeric,
    nullif(c#>>'{rendimientos,dias_180,directo}','')::numeric,
    nullif(c#>>'{rendimientos,meses_12,tna}','')::numeric,
    nullif(c#>>'{rendimientos,meses_12,directo}','')::numeric,
    nullif(c#>>'{rendimientos,ytd,tna}','')::numeric,
    nullif(c#>>'{rendimientos,ytd,directo}','')::numeric,
    c->'rendimientos'
  from jsonb_array_elements(resp->'clases') as c;

  get diagnostics v_cnt = row_count;

  return jsonb_build_object(
    'ok', true,
    'snapshot_id', v_snap,
    'fecha_base', resp->>'fecha_base',
    'generated_at', resp->>'generated_at',
    'clases_guardadas', v_cnt
  );
end;
$$;

-- Solo service_role / postgres (cron) pueden ejecutarla
revoke execute on function public.cafci_load_snapshot() from anon, authenticated, public;
