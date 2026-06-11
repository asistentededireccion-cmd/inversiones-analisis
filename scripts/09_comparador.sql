-- Comparador: rendimiento nominal y real (Fisher, vs inflacion interanual) por instrumento
create or replace view public.comparador_instrumentos as
with
infl as (select mensual, interanual, fecha from public.inflacion order by fecha desc limit 1),
mm as (
  select max(tna_mes_1) as best, avg(tna_mes_1) as prom
  from public.cafci_fondos_latest
  where moneda_nombre='Peso Argentina' and tipo_dinero='Clásico' and tna_mes_1 is not null
),
pf as (select max(tna_clientes) as best from public.plazo_fijo
       where fecha=(select max(fecha) from public.plazo_fijo)),
mep_hoy as (select venta v, fecha from public.dolar where casa='bolsa' order by fecha desc limit 1),
mep_365 as (select venta v from public.dolar where casa='bolsa'
            and fecha <= (select fecha from mep_hoy) - 365 order by fecha desc limit 1)
select * from (
  select 1 orden, 'Inflación'::text instrumento, (to_char((select fecha from infl),'YYYY-MM')||' · interanual')::text detalle,
         (select interanual from infl) nominal_anual, 0::numeric real_anual
  union all
  select 2, 'Money Market (mejor)', 'FCI pesos clásico · TNA 30d',
         round((select best from mm),2),
         round(((1+(select best from mm)/100)/(1+(select interanual from infl)/100)-1)*100,2)
  union all
  select 3, 'Money Market (promedio)', 'FCI pesos clásico · TNA 30d',
         round((select prom from mm),2),
         round(((1+(select prom from mm)/100)/(1+(select interanual from infl)/100)-1)*100,2)
  union all
  select 4, 'Plazo Fijo (mejor banco)', 'TNA clientes',
         round((select best from pf),2),
         round(((1+(select best from pf)/100)/(1+(select interanual from infl)/100)-1)*100,2)
  union all
  select 5, 'Dólar MEP', 'Devaluación últ. 12m',
         round(((select v from mep_hoy)/(select v from mep_365)-1)*100,2),
         round((((select v from mep_hoy)/(select v from mep_365))/(1+(select interanual from infl)/100)-1)*100,2)
) t order by orden;
grant select on public.comparador_instrumentos to anon, authenticated;

-- Panel macro: dolares, brecha y riesgo pais
create or replace view public.panel_macro as
with d as (
  select casa, venta, row_number() over (partition by casa order by fecha desc) rn
  from public.dolar
)
select
  (select venta from d where casa='bolsa' and rn=1)            as mep,
  (select venta from d where casa='contadoconliqui' and rn=1)  as ccl,
  (select venta from d where casa='blue' and rn=1)             as blue,
  (select venta from d where casa='oficial' and rn=1)          as oficial,
  round((((select venta from d where casa='bolsa' and rn=1)
        /(select venta from d where casa='oficial' and rn=1))-1)*100,1) as brecha_mep_pct,
  (select valor from public.riesgo_pais order by fecha desc limit 1)    as riesgo_pais,
  (select max(fecha) from public.dolar)                        as fecha;
grant select on public.panel_macro to anon, authenticated;
