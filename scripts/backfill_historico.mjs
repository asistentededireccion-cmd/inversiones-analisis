// Backfill histórico de acciones y CEDEARs líderes desde Yahoo Finance (.BA, en ARS)
// hacia public.cotizaciones_mercado. Uso: node scripts/backfill_historico.mjs
// Escribe vía Management API (PAT) — mismo patrón que scripts/sbq.py.
const PAT = process.env.SB_PAT; // export SB_PAT=sbp_... (nunca hardcodear)
if (!PAT) { console.error("Falta SB_PAT en el entorno (export SB_PAT=sbp_...)"); process.exit(1); }
const REF = "kqwuvhfgykhjosglsznd";
const QURL = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const RANGE = process.env.RANGE || "2y";
const TOP_CEDEARS = Number(process.env.TOP_CEDEARS || 80);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sbq(sql) {
  const r = await fetch(QURL, {
    method: "POST",
    headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json", "User-Agent": "curl/8.0" },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`sbq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

function artDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
}

async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.BA?range=${RANGE}&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) return [];
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res || !res.timestamp) return [];
  const ts = res.timestamp;
  const q = res.indicators.quote[0];
  const closes = q.close || [], vols = q.volume || [];
  const out = [];
  let prev = null;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const pct = prev != null && prev !== 0 ? (c / prev - 1) * 100 : null;
    out.push({ fecha: artDate(ts[i]), ultimo: c, volumen: vols[i] ?? null, pct });
    prev = c;
  }
  return out;
}

const num = (x) => (x == null || Number.isNaN(x) ? "null" : String(x));

async function insertRows(rows) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values = chunk.map((r) =>
      `('${r.fecha}','${r.tipo}','${r.symbol.replace(/'/g, "''")}',${num(r.ultimo)},${num(r.pct)},${num(r.volumen)})`
    ).join(",");
    const sql = `insert into public.cotizaciones_mercado (fecha,tipo,symbol,ultimo,pct_change,volumen) values ${values}
      on conflict (fecha,tipo,symbol) do update set
        ultimo=excluded.ultimo,
        pct_change=coalesce(excluded.pct_change, public.cotizaciones_mercado.pct_change),
        volumen=excluded.volumen;`;
    await sbq(sql);
  }
}

async function main() {
  const acc = (await sbq(`select symbol from public.cotizaciones_mercado where tipo='accion' order by symbol`)).map((r) => r.symbol);
  const ced = (await sbq(`select symbol from public.cotizaciones_mercado where tipo='cedear' order by volumen desc nulls last limit ${TOP_CEDEARS}`)).map((r) => r.symbol);
  const list = [...acc.map((s) => ({ s, tipo: "accion" })), ...ced.map((s) => ({ s, tipo: "cedear" }))];
  console.log(`Backfill ${RANGE}: ${acc.length} acciones + ${ced.length} cedears = ${list.length} símbolos`);
  let okSym = 0, totalRows = 0;
  const fail = [];
  for (let i = 0; i < list.length; i++) {
    const { s, tipo } = list[i];
    try {
      const bars = await yahoo(s);
      if (bars.length) {
        await insertRows(bars.map((b) => ({ ...b, tipo, symbol: s })));
        okSym++; totalRows += bars.length;
      } else fail.push(s);
    } catch (e) { fail.push(`${s}:${e.message}`); }
    if (i % 20 === 0) console.log(`[${i + 1}/${list.length}] ok=${okSym} filas=${totalRows}`);
    await sleep(250);
  }
  console.log(`LISTO. símbolos OK=${okSym}/${list.length}, filas=${totalRows}, sin datos=${fail.length}`);
  if (fail.length) console.log("sin datos:", fail.slice(0, 50).join(", "));
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
