-- Métricas derivadas por instrumento (acciones / CEDEARs / bonos / letras).
-- Se calculan en SQL (determinístico y barato) en vez de pedírselas al LLM.
-- Fuente: serie diaria public.cotizaciones_mercado (hay ~2 años para acciones/cedears).
-- Ventana de cálculo: últimos 365 días corridos por símbolo.
--   vol_anual_pct   = desvío estándar de los retornos diarios * sqrt(252) (anualizado), solo si n_dias>=20
--   max_drawdown_pct= peor caída desde un máximo previo dentro de la ventana
--   real_12m_pct    = retorno nominal 12m descontada la inflación interanual (Fisher)
create or replace view public.instrumento_metricas as
with infl as (
  select interanual from public.inflacion order by fecha desc limit 1
),
base as (
  select tipo, symbol, fecha, ultimo,
         max(fecha) over (partition by tipo, symbol) as ult_fecha
  from public.cotizaciones_mercado
  where ultimo is not null and ultimo > 0
),
win as (
  select * from base where fecha > ult_fecha - 365
),
rets as (
  select tipo, symbol, ult_fecha, ultimo,
         ultimo / nullif(lag(ultimo) over (partition by tipo, symbol order by fecha), 0) - 1 as ret,
         max(ultimo) over (partition by tipo, symbol order by fecha
                           rows between unbounded preceding and current row) as run_max
  from win
),
agg as (
  select tipo, symbol,
         count(*) as n_dias,
         case when count(*) >= 20
              then round((stddev_samp(ret) * sqrt(252) * 100)::numeric, 1) end as vol_anual_pct,
         round((min(ultimo / nullif(run_max, 0) - 1) * 100)::numeric, 1) as max_drawdown_pct
  from rets
  group by tipo, symbol
)
select
  r.tipo, r.symbol, r.fecha, r.px, r.vol,
  r.var_30d, r.var_90d, r.var_12m,
  round(((1 + r.var_12m / 100) / nullif(1 + (select interanual from infl) / 100, 0) - 1) * 100, 1) as real_12m_pct,
  coalesce(a.n_dias, 1)   as n_dias,
  a.vol_anual_pct,
  a.max_drawdown_pct
from public.cotizaciones_rendimientos r
left join agg a on a.tipo = r.tipo and a.symbol = r.symbol;

grant select on public.instrumento_metricas to anon, authenticated;
