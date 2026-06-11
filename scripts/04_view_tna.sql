drop view if exists public.cafci_fondos_latest;
create view public.cafci_fondos_latest as
select
  f.fondo_nombre, f.clase_nombre, f.sociedad, f.moneda_nombre, f.tipo_dinero,
  f.valor_cuotaparte, f.patrimonio_neto,
  f.tna_dia, f.dir_dia,
  f.tna_7d, f.dir_7d,
  f.tna_mes_1, f.dir_mes_1,
  f.tna_90d, f.tna_180d, f.tna_12m,
  f.tna_ytd, f.dir_ytd,
  f.fecha_base
from public.cafci_fondos f
join (select id from public.cafci_snapshots order by fecha_base desc limit 1) s
  on f.snapshot_id = s.id;
grant select on public.cafci_fondos_latest to anon, authenticated;
