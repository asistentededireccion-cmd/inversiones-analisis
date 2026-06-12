// refresh-mercado — dispara la recarga de datos de mercado (refresh_instrumentos) on-demand.
// Patrón asíncrono: lanza el refresh en segundo plano (EdgeRuntime.waitUntil) y responde al
// instante con la frescura "antes"; la app hace polling de mercado_freshness hasta ver que
// `ultima_captura` avanzó. Así no depende de mantener una conexión HTTP durante los ~20-40s
// que tardan los http_get sincrónicos de los loaders. CORS *, sin auth (cooldown anti-abuso).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SB_URL}/rest/v1`;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const COOLDOWN_S = 30; // evita disparos repetidos (doble click, bots)

function json(b: unknown, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function freshness(): Promise<any> {
  const r = await fetch(`${REST}/rpc/mercado_freshness`, { headers: H });
  return r.ok ? await r.json() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const fresh = await freshness();
  const ultimaMs = fresh?.ultima_captura ? new Date(fresh.ultima_captura).getTime() : 0;
  const edadS = ultimaMs ? (Date.now() - ultimaMs) / 1000 : Infinity;

  if (edadS < COOLDOWN_S) {
    return json({ started: false, motivo: "reciente", edad_segundos: Math.round(edadS), freshness: fresh });
  }

  // Dispara el refresh en segundo plano; la app sigue por polling de mercado_freshness.
  const task = fetch(`${REST}/rpc/mercado_refresh_now`, { method: "POST", headers: H, body: "{}" })
    .then((r) => r.ok ? null : r.text().then((t) => console.error("refresh_now:", t)))
    .catch((e) => console.error("refresh_now:", e));
  // @ts-ignore EdgeRuntime es global en el runtime de Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(task);

  return json({ started: true, before: fresh?.ultima_captura ?? null, freshness: fresh });
});
