# Portal de Inversor — Montagne

Central de decisión de inversión para el mercado argentino. Compara, en términos
**reales** (netos de inflación), money market, plazo fijo, dólar, bonos CER, acciones y
CEDEARs — y suma un **Asesor IA** conversacional que recomienda dónde invertir respaldado
en los datos del portal.

## Componentes

- **`index.html`** — frontend autocontenido (un archivo). Lee Supabase vía PostgREST con la
  anon key embebida (pública por diseño; el acceso se protege con RLS). Pestañas: Resumen,
  Money Market, Renta Fija, Dólar, Acciones/CEDEARs, Histórico y **Asesor IA**.
- **`supabase/functions/`** — Edge Functions (Deno):
  - `asesor-ia` — chat con IA (agnóstico de proveedor: `AI_PROVIDER` = `openai` | `anthropic`),
    arma el snapshot de mercado + cartera del inversor, streaming, y mide consumo en USD.
  - `portal` — login por clave privada, ABM de cartera y consumo por usuario.
  - `cafci-snapshot` — captura de fondos Money Market (CAFCI).
- **`scripts/`** — SQL del esquema/loaders/crons (numerados) + helpers:
  - `sbq.py` — ejecuta SQL contra Supabase vía Management API.
  - `backfill_historico.mjs` — backfill de histórico de acciones/CEDEARs desde Yahoo Finance.

## Datos

Supabase (Postgres + pg_cron + extensión `http`). Fuentes: CAFCI, INDEC/ArgentinaDatos,
BCRA, data912.com y Yahoo Finance. Crons diarios refrescan inflación, dólar, plazo fijo,
riesgo país, UVA, cotizaciones e histórico.

## Configuración (secretos — NO se commitean)

Variables de entorno / secretos requeridos:

| Dónde | Variable | Para qué |
|---|---|---|
| Scripts locales | `SB_PAT` | Personal Access Token de Supabase (Management API) |
| Edge Function `asesor-ia` | `AI_PROVIDER` | `openai` o `anthropic` |
| Edge Function `asesor-ia` | `OPENAI_API_KEY` / `OPENAI_MODEL` | proveedor OpenAI |
| Edge Function `asesor-ia` | `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | proveedor Anthropic |

Las Edge Functions reciben automáticamente `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.

> No es asesoramiento financiero. Rendimientos pasados no garantizan futuros.
