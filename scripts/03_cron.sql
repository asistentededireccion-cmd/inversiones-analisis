-- Gate: ejecutar la carga solo si HOY es el ultimo dia del mes (hora Argentina)
create or replace function public.cafci_run_if_month_end()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  hoy_art date := (now() at time zone 'America/Argentina/Buenos_Aires')::date;
begin
  if extract(day from (hoy_art + interval '1 day')) = 1 then
    perform public.cafci_load_snapshot();
  end if;
end;
$$;

revoke execute on function public.cafci_run_if_month_end() from anon, authenticated, public;

-- Reprogramar de forma idempotente
select cron.unschedule('cafci-month-end-snapshot')
where exists (select 1 from cron.job where jobname = 'cafci-month-end-snapshot');

-- Corre a diario 21:00 UTC (18:00 ART); el gate decide si dispara
select cron.schedule(
  'cafci-month-end-snapshot',
  '0 21 * * *',
  $$ select public.cafci_run_if_month_end(); $$
);
