select cron.unschedule('inflacion-refresh')
where exists (select 1 from cron.job where jobname = 'inflacion-refresh');

-- INDEC publica el IPC a mitad de mes; corremos a diario (fetch chico, upsert idempotente)
select cron.schedule('inflacion-refresh', '30 12 * * *', $$ select public.load_inflacion(); $$);
