create or replace function public.load_cripto()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb; v_cnt int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/rendimientos');
  if resp is null then raise exception 'cripto vacio'; end if;
  insert into public.rendimientos_cripto (fecha, entidad, moneda, apy)
  select distinct on (fecha, entidad, moneda) fecha, entidad, moneda, apy
  from (
    select nullif(r->>'fecha','')::date as fecha, e->>'entidad' as entidad,
           r->>'moneda' as moneda, nullif(r->>'apy','')::numeric as apy
    from jsonb_array_elements(resp) e, lateral jsonb_array_elements(e->'rendimientos') r
    where r->>'fecha' is not null
  ) s
  order by fecha, entidad, moneda
  on conflict (fecha, entidad, moneda) do update set apy=excluded.apy, captured_at=now();
  get diagnostics v_cnt = row_count;
  return jsonb_build_object('ok',true,'filas_afectadas',v_cnt);
end; $$;
revoke execute on function public.load_cripto() from anon, authenticated, public;
