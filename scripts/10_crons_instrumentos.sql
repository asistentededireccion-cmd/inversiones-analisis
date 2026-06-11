-- Refresco diario de datos de mercado (dolar, plazo fijo, riesgo pais)
create or replace function public.refresh_instrumentos()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.load_dolar();
  perform public.load_plazo_fijo();
  perform public.load_riesgo_pais();
  return jsonb_build_object('ok', true, 'ts', now());
end; $$;
revoke execute on function public.refresh_instrumentos() from anon, authenticated, public;

select cron.unschedule('mercado-refresh')
where exists (select 1 from cron.job where jobname='mercado-refresh');
select cron.schedule('mercado-refresh', '0 13 * * *', $$ select public.refresh_instrumentos(); $$);
