drop view if exists public.cafci_fondos_latest;
create view public.cafci_fondos_latest as
with infl as (
  select mensual, interanual, fecha from public.inflacion order by fecha desc limit 1
)
select
  f.fondo_nombre, f.clase_nombre, f.sociedad, f.moneda_nombre, f.tipo_dinero,
  f.valor_cuotaparte, f.patrimonio_neto,
  f.tna_dia, f.dir_dia, f.tna_7d, f.dir_7d, f.tna_mes_1, f.dir_mes_1,
  f.tna_90d, f.tna_180d, f.tna_12m, f.tna_ytd, f.dir_ytd,
  f.fecha_base,
  i.mensual    as infl_mensual,
  i.interanual as infl_interanual,
  i.fecha      as infl_fecha,
  round(((1 + f.dir_mes_1/100) / (1 + i.mensual/100)    - 1) * 100, 2) as real_30d,
  round(((1 + f.tna_mes_1/100) / (1 + i.interanual/100) - 1) * 100, 2) as tna_real
from public.cafci_fondos f
join (select id from public.cafci_snapshots order by fecha_base desc limit 1) s
  on f.snapshot_id = s.id
left join infl i on true;
grant select on public.cafci_fondos_latest to anon, authenticated;
