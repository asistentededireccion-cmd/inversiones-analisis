-- Cripto: deduplicar dentro del mismo insert (distinct on)
create or replace function public.load_cripto()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/rendimientos');
  if resp is null then raise exception 'cripto vacio'; end if;
  insert into public.rendimientos_cripto (fecha, entidad, moneda, apy)
  select distinct on (fecha, entidad, moneda)
         nullif(r->>'fecha','')::date, e->>'entidad', r->>'moneda', nullif(r->>'apy','')::numeric
  from jsonb_array_elements(resp) e, lateral jsonb_array_elements(e->'rendimientos') r
  where r->>'fecha' is not null
  order by fecha, entidad, moneda
  on conflict (fecha, entidad, moneda) do update set apy=excluded.apy, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'filas_afectadas',v_cnt);
end; $$;
revoke execute on function public.load_cripto() from anon, authenticated, public;

-- Tasas 30d: guardar valor crudo (fuente mezcla escalas; el grafico usa solo fechas recientes en %)
truncate public.tasas_30dias;
create or replace function public.load_tasas_30dias()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','45000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/tasas/depositos30Dias');
  if resp is null then raise exception 'tasas30 vacio'; end if;
  insert into public.tasas_30dias (fecha, tna)
  select (e->>'fecha')::date, nullif(e->>'valor','')::numeric
  from jsonb_array_elements(resp) e
  on conflict (fecha) do update set tna=excluded.tna, captured_at=now();
  return jsonb_build_object('ok',true,'total',(select count(*) from public.tasas_30dias),
    'tna_ultimo',(select tna from public.tasas_30dias order by fecha desc limit 1));
end; $$;
revoke execute on function public.load_tasas_30dias() from anon, authenticated, public;
