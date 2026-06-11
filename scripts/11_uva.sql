create table if not exists public.uva (
  fecha       date primary key,
  valor       numeric,
  captured_at timestamptz not null default now()
);
alter table public.uva enable row level security;
drop policy if exists "uva lectura publica" on public.uva;
create policy "uva lectura publica" on public.uva for select to anon, authenticated using (true);

create or replace function public.load_uva()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare resp jsonb;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT_MS','30000');
  select content::jsonb into resp from http_get('https://api.argentinadatos.com/v1/finanzas/indices/uva');
  if resp is null then raise exception 'uva vacio'; end if;
  insert into public.uva (fecha, valor)
  select (e->>'fecha')::date, nullif(e->>'valor','')::numeric
  from jsonb_array_elements(resp) e
  on conflict (fecha) do update set valor=excluded.valor, captured_at=now();
  return jsonb_build_object('ok',true,'ultimo',(select max(fecha) from public.uva),
    'valor',(select valor from public.uva order by fecha desc limit 1));
end; $$;
revoke execute on function public.load_uva() from anon, authenticated, public;

-- Sumar UVA al refresco diario de instrumentos
create or replace function public.refresh_instrumentos()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.load_dolar();
  perform public.load_plazo_fijo();
  perform public.load_riesgo_pais();
  perform public.load_uva();
  return jsonb_build_object('ok', true, 'ts', now());
end; $$;
revoke execute on function public.refresh_instrumentos() from anon, authenticated, public;
