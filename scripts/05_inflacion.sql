-- Tabla de inflacion INDEC (fuente: api.argentinadatos.com)
create table if not exists public.inflacion (
  fecha       date primary key,           -- ultimo dia del mes
  mensual     numeric,                     -- variacion % mensual
  interanual  numeric,                     -- variacion % i.a.
  captured_at timestamptz not null default now()
);

alter table public.inflacion enable row level security;

drop policy if exists "inflacion lectura publica" on public.inflacion;
create policy "inflacion lectura publica"
  on public.inflacion for select to anon, authenticated using (true);

-- Cargador: trae mensual + interanual y hace upsert por fecha
create or replace function public.load_inflacion()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_mens  jsonb;
  v_inter jsonb;
  v_cnt   int;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS', '30000');
  select content::jsonb into v_mens
    from http_get('https://api.argentinadatos.com/v1/finanzas/indices/inflacion');
  select content::jsonb into v_inter
    from http_get('https://api.argentinadatos.com/v1/finanzas/indices/inflacionInteranual');

  if v_mens is null then raise exception 'inflacion mensual vacia'; end if;

  insert into public.inflacion (fecha, mensual)
  select (e->>'fecha')::date, nullif(e->>'valor','')::numeric
  from jsonb_array_elements(v_mens) e
  on conflict (fecha) do update set mensual = excluded.mensual, captured_at = now();

  if v_inter is not null then
    insert into public.inflacion (fecha, interanual)
    select (e->>'fecha')::date, nullif(e->>'valor','')::numeric
    from jsonb_array_elements(v_inter) e
    on conflict (fecha) do update set interanual = excluded.interanual, captured_at = now();
  end if;

  select count(*) into v_cnt from public.inflacion;
  return jsonb_build_object('ok', true, 'filas', v_cnt,
    'ultimo_mes', (select max(fecha) from public.inflacion));
end;
$$;

revoke execute on function public.load_inflacion() from anon, authenticated, public;
