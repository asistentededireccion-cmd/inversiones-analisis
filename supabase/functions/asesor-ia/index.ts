// asesor-ia — Asesor de Inversiones AGÉNTICO: chat con herramientas sobre el mercado argentino.
// El modelo ya no recibe un JSON gigante fijo: tiene un contexto base chico + HERRAMIENTAS para
// investigar en vivo (buscar instrumentos, rankings, series, money market, perfil, recomendaciones).
// Agnóstico de proveedor: AI_PROVIDER = "anthropic" (Claude) | "openai" (default operativo).
// Protocolo de salida al navegador: NDJSON (una línea JSON por evento):
//   {"t":"token","v":"texto"}  · {"t":"tool","name":"...","arg":"..."}  · {"t":"done"}  · {"t":"error","v":"..."}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SB_URL}/rest/v1`;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

const PROVIDER = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();
const MAX_ROUNDS = 6; // tope de rondas de herramientas por consulta

// USD por 1M tokens [input, output]. OpenAI: valores aproximados (cutoff mediados 2025).
const PRICES: Record<string, [number, number]> = {
  "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25],
  "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [1, 5],
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8], "gpt-4.1-mini": [0.4, 1.6], "gpt-4.1-nano": [0.1, 0.4],
};

function providerConf() {
  if (PROVIDER === "openai") {
    return { name: "openai", key: Deno.env.get("OPENAI_API_KEY") ?? "", keyName: "OPENAI_API_KEY", model: Deno.env.get("OPENAI_MODEL") ?? "gpt-4o" };
  }
  return { name: "anthropic", key: Deno.env.get("ANTHROPIC_API_KEY") ?? "", keyName: "ANTHROPIC_API_KEY", model: Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-4-8" };
}

function costOf(model: string, u: { input: number; output: number; cacheCreate: number; cacheRead: number }, provider: string): number {
  const [pIn, pOut] = PRICES[model] ?? (provider === "openai" ? [2.5, 10] : [5, 25]);
  if (provider === "openai") {
    const cached = u.cacheRead || 0;
    const fresh = Math.max(0, u.input - cached);
    return fresh / 1e6 * pIn + cached / 1e6 * pIn * 0.5 + u.output / 1e6 * pOut;
  }
  return u.input / 1e6 * pIn + u.output / 1e6 * pOut + u.cacheCreate / 1e6 * pIn * 1.25 + u.cacheRead / 1e6 * pIn * 0.1;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-portal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-conversacion-id",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sbGet(path: string): Promise<any[]> {
  const r = await fetch(`${REST}/${path}`, { headers: H });
  return r.ok ? await r.json() : [];
}
async function sbInsert(table: string, row: unknown, returning = false): Promise<any> {
  const r = await fetch(`${REST}/${table}`, {
    method: "POST",
    headers: { ...H, Prefer: returning ? "return=representation" : "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(await r.text());
  return returning ? await r.json() : null;
}

// ───────────────────────── Herramientas (canónicas; se traducen por proveedor) ─────────────────────────
const TOOLS = [
  {
    name: "buscar_instrumento",
    description: "Datos y métricas de UNA acción o CEDEAR por su símbolo (ej. GGAL, YPFD, AAPL). Devuelve precio en pesos, variación nominal 30/90/365 días, rendimiento REAL 12m (neto de inflación), volatilidad anualizada, máximo drawdown y cantidad de ruedas con histórico.",
    parameters: { type: "object", properties: {
      symbol: { type: "string", description: "Símbolo/ticker, ej. 'GGAL'" },
      tipo: { type: "string", enum: ["accion", "cedear"], description: "Opcional; si se omite busca en ambos" },
    }, required: ["symbol"] },
  },
  {
    name: "ranking_instrumentos",
    description: "Ranking de acciones o CEDEARs ordenado por una métrica. Sirve para encontrar oportunidades, los más líquidos o los de mejor/peor rendimiento real.",
    parameters: { type: "object", properties: {
      tipo: { type: "string", enum: ["accion", "cedear"] },
      orden: { type: "string", enum: ["vol", "var_30d", "var_90d", "var_12m", "real_12m_pct", "vol_anual_pct"], description: "Métrica de orden. 'vol' = volumen operado (liquidez). Default vol." },
      descendente: { type: "boolean", description: "true (default) = mayor a menor" },
      limite: { type: "integer", description: "1-25, default 10" },
    }, required: ["tipo"] },
  },
  {
    name: "serie_historica",
    description: "Serie de precios de cierre (hasta ~60 puntos) de una acción o CEDEAR para analizar tendencia o graficar. Devolvé un gráfico al inversor cuando ayude.",
    parameters: { type: "object", properties: {
      symbol: { type: "string" },
      tipo: { type: "string", enum: ["accion", "cedear"] },
      dias: { type: "integer", description: "Días corridos hacia atrás (30-730, default 180)" },
    }, required: ["symbol"] },
  },
  {
    name: "fondos_money_market",
    description: "Fondos Money Market / FCI (CAFCI) en pesos con TNA, TNA real y rendimiento real mensual. Default: clásicos en pesos ordenados por patrimonio.",
    parameters: { type: "object", properties: {
      orden: { type: "string", enum: ["patrimonio_neto", "tna_mes_1", "tna_real", "real_30d"] },
      limite: { type: "integer", description: "1-20, default 10" },
    }, required: [] },
  },
  {
    name: "plazo_fijo_top",
    description: "Mejores TNA de plazo fijo por banco (último dato disponible).",
    parameters: { type: "object", properties: { limite: { type: "integer", description: "1-20, default 10" } }, required: [] },
  },
  {
    name: "guardar_perfil",
    description: "Guarda o actualiza el perfil del inversor (MEMORIA entre conversaciones). Llamala cuando el inversor aporte o cambie monto disponible, horizonte temporal, tolerancia al riesgo, moneda objetivo o su objetivo. Mandá solo los campos que conozcas.",
    parameters: { type: "object", properties: {
      monto_disponible: { type: "number" },
      moneda: { type: "string", enum: ["ARS", "USD"] },
      horizonte: { type: "string", enum: ["corto", "medio", "largo"] },
      tolerancia: { type: "string", enum: ["conservador", "moderado", "agresivo"] },
      objetivo: { type: "string" },
      notas: { type: "string" },
    }, required: [] },
  },
  {
    name: "registrar_recomendacion",
    description: "Registra una recomendación concreta para poder medir después si acertaste. Para acciones/CEDEARs poné el SYMBOL en 'instrumento' (ej. 'GGAL') y el precio actual en 'precio_ref'.",
    parameters: { type: "object", properties: {
      instrumento: { type: "string" },
      tipo: { type: "string", enum: ["money_market", "plazo_fijo", "bono", "dolar", "accion", "cedear", "cripto", "otro"] },
      precio_ref: { type: "number" },
      horizonte: { type: "string", enum: ["corto", "medio", "largo"] },
      tesis: { type: "string", description: "Por qué la recomendás (1-2 frases)" },
    }, required: ["instrumento", "tipo", "tesis"] },
  },
  {
    name: "seguimiento_recomendaciones",
    description: "Lista las recomendaciones ya registradas para este inversor y su rendimiento desde que se emitieron (el % aplica a acciones/CEDEARs con symbol).",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

const ORDER_RANKING = new Set(["vol", "var_30d", "var_90d", "var_12m", "real_12m_pct", "vol_anual_pct"]);
const ORDER_MM = new Set(["patrimonio_neto", "tna_mes_1", "tna_real", "real_30d"]);
const TIPO_RECO = new Set(["money_market", "plazo_fijo", "bono", "dolar", "accion", "cedear", "cripto", "otro"]);
const HORIZONTE = new Set(["corto", "medio", "largo"]);
const PERFIL_ENUMS: Record<string, Set<string>> = {
  moneda: new Set(["ARS", "USD"]), horizonte: HORIZONTE, tolerancia: new Set(["conservador", "moderado", "agresivo"]),
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

async function runTool(name: string, args: any, ctx: { user: any; conversacionId: string }): Promise<unknown> {
  try {
    if (name === "buscar_instrumento") {
      const sym = String(args.symbol ?? "").toUpperCase().trim();
      if (!sym) return { error: "Falta symbol." };
      const cols = "select=tipo,symbol,fecha,px,var_30d,var_90d,var_12m,real_12m_pct,vol_anual_pct,max_drawdown_pct,n_dias";
      const tipoF = (args.tipo === "accion" || args.tipo === "cedear") ? `&tipo=eq.${args.tipo}` : "";
      let rows = await sbGet(`instrumento_metricas?symbol=eq.${encodeURIComponent(sym)}${tipoF}&${cols}`);
      if (!rows.length) rows = await sbGet(`instrumento_metricas?symbol=ilike.*${encodeURIComponent(sym)}*${tipoF}&${cols}&limit=8`);
      return rows.length ? { resultados: rows } : { error: `No encontré '${sym}' entre acciones/CEDEARs con histórico.` };
    }
    if (name === "ranking_instrumentos") {
      const tipo = args.tipo === "cedear" ? "cedear" : "accion";
      const orden = ORDER_RANKING.has(args.orden) ? args.orden : "vol";
      const dir = args.descendente === false ? "asc" : "desc";
      const lim = clamp(Number(args.limite) || 10, 1, 25);
      const rows = await sbGet(`instrumento_metricas?tipo=eq.${tipo}&order=${orden}.${dir}.nullslast&limit=${lim}` +
        `&select=symbol,px,var_30d,var_90d,var_12m,real_12m_pct,vol_anual_pct,max_drawdown_pct,vol`);
      return { tipo, orden, resultados: rows };
    }
    if (name === "serie_historica") {
      const sym = String(args.symbol ?? "").toUpperCase().trim();
      if (!sym) return { error: "Falta symbol." };
      let tipo = (args.tipo === "accion" || args.tipo === "cedear") ? args.tipo : null;
      if (!tipo) {
        const t = await sbGet(`instrumento_metricas?symbol=eq.${encodeURIComponent(sym)}&select=tipo&limit=1`);
        tipo = t[0]?.tipo ?? null;
      }
      if (!tipo) return { error: `No sé el tipo de '${sym}'.` };
      const dias = clamp(Number(args.dias) || 180, 30, 730);
      const raw = await sbGet(`cotizaciones_mercado?tipo=eq.${tipo}&symbol=eq.${encodeURIComponent(sym)}` +
        `&ultimo=not.is.null&order=fecha.desc&limit=${dias}&select=fecha,ultimo`);
      const asc = raw.reverse();
      const step = Math.max(1, Math.ceil(asc.length / 60));
      const pts = asc.filter((_, i) => i % step === 0 || i === asc.length - 1).map((r) => ({ f: r.fecha, p: r.ultimo }));
      return { tipo, symbol: sym, total_dias: asc.length, puntos: pts };
    }
    if (name === "fondos_money_market") {
      const orden = ORDER_MM.has(args.orden) ? args.orden : "patrimonio_neto";
      const lim = clamp(Number(args.limite) || 10, 1, 20);
      const peso = encodeURIComponent("Peso Argentina"), clasico = encodeURIComponent("Clásico");
      const rows = await sbGet(`cafci_fondos_latest?moneda_nombre=eq.${peso}&tipo_dinero=eq.${clasico}` +
        `&order=${orden}.desc.nullslast&limit=${lim}&select=fondo_nombre,sociedad,tna_mes_1,tna_real,real_30d,patrimonio_neto,fecha_base`);
      return { resultados: rows.map((f) => ({
        fondo: f.fondo_nombre, sociedad: f.sociedad, tna_30d: f.tna_mes_1, tna_real: f.tna_real, real_mensual: f.real_30d,
        patrimonio_millones: f.patrimonio_neto != null ? Math.round(f.patrimonio_neto / 1e6) : null, fecha: f.fecha_base,
      })) };
    }
    if (name === "plazo_fijo_top") {
      const lim = clamp(Number(args.limite) || 10, 1, 20);
      const all = await sbGet(`plazo_fijo?order=fecha.desc,tna_clientes.desc&limit=80&select=entidad,tna_clientes,fecha`);
      const f = all[0]?.fecha;
      return { fecha: f, resultados: all.filter((r) => r.fecha === f).slice(0, lim) };
    }
    if (name === "guardar_perfil") {
      const row: any = { usuario_id: ctx.user.id, updated_at: new Date().toISOString() };
      if (args.monto_disponible != null && args.monto_disponible !== "") row.monto_disponible = Number(args.monto_disponible);
      for (const k of ["moneda", "horizonte", "tolerancia"]) {
        if (args[k] != null && args[k] !== "") {
          if (!PERFIL_ENUMS[k].has(args[k])) return { error: `Valor inválido para ${k}.` };
          row[k] = args[k];
        }
      }
      for (const k of ["objetivo", "notas"]) if (args[k] != null && args[k] !== "") row[k] = String(args[k]);
      const r = await fetch(`${REST}/ai_perfil?on_conflict=usuario_id`, {
        method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(row),
      });
      if (!r.ok) { console.error("guardar_perfil:", await r.text()); return { error: "No se pudo guardar el perfil." }; }
      const ins = await r.json();
      return { guardado: ins[0] ?? row };
    }
    if (name === "registrar_recomendacion") {
      if (!args.instrumento || !TIPO_RECO.has(args.tipo)) return { error: "Falta instrumento y/o tipo válido." };
      const precio = args.precio_ref != null && args.precio_ref !== "" ? Number(args.precio_ref) : null;
      const row = {
        usuario_id: ctx.user.id, conversacion_id: ctx.conversacionId,
        instrumento: String(args.instrumento), tipo: args.tipo,
        precio_ref: Number.isFinite(precio as number) ? precio : null,
        horizonte: HORIZONTE.has(args.horizonte) ? args.horizonte : null, tesis: args.tesis ? String(args.tesis) : null,
      };
      try {
        const ins = await sbInsert("ai_recomendaciones", row, true);
        return { registrada: ins?.[0] ?? row };
      } catch (e) { console.error("registrar_recomendacion:", (e as Error)?.message); return { error: "No se pudo registrar la recomendación." }; }
    }
    if (name === "seguimiento_recomendaciones") {
      const rows = await sbGet(`ai_recomendaciones_seguimiento?usuario_id=eq.${ctx.user.id}&order=fecha.desc&limit=30` +
        `&select=instrumento,tipo,fecha,precio_ref,px_actual,var_desde_reco_pct,horizonte,tesis`);
      return { resultados: rows };
    }
    return { error: `Herramienta desconocida: ${name}` };
  } catch (e) {
    console.error("runTool", name, (e as Error)?.message ?? e);
    return { error: "Error al ejecutar la herramienta." };
  }
}

function shortArg(args: any): string {
  const v = args?.symbol ?? args?.instrumento ?? args?.tipo ?? Object.values(args ?? {})[0];
  return v != null ? String(v) : "";
}

// ───────────────────────── Prompt + contexto base ─────────────────────────
const SYSTEM_PROMPT = `Sos el Asesor de Inversiones de Montagne, un asistente financiero para el mercado argentino. Ayudás a un inversor a decidir dónde colocar su dinero, con honestidad y respaldado en datos.

REGLAS:
- Razoná SIEMPRE en términos REALES (netos de inflación). En Argentina una tasa nominal alta puede ser un rendimiento real negativo; ese es el dato clave.
- Usá EXCLUSIVAMENTE números reales: los del CONTEXTO BASE o los que devuelvan las HERRAMIENTAS. No inventes cifras, símbolos ni cotizaciones de tu memoria. Si un dato no está, conseguilo con una herramienta o decí que no lo tenés.
- Tenés herramientas para investigar en vivo (buscar_instrumento, ranking_instrumentos, serie_historica, fondos_money_market, plazo_fijo_top, etc.). Usalas EN SILENCIO antes de responder: no narres "voy a consultar...", simplemente consultá y después contestá con los datos.
- Para recomendar necesitás el perfil del inversor: monto, horizonte, tolerancia al riesgo y moneda objetivo. El perfil y la cartera vienen en el CONTEXTO BASE. Si falta algo, PREGUNTÁ de forma natural antes de recomendar. Cuando el inversor te dé esos datos, guardalos con guardar_perfil.
- Usá la cartera del inversor para contextualizar: qué ya tiene, cómo está diversificado, qué le rindió. Señalá concentraciones de riesgo.
- Cuando hagas una recomendación CONCRETA de un instrumento, registrala con registrar_recomendacion (para acciones/CEDEARs usá el symbol y el precio actual) así después podemos medir el acierto.
- Sé honesto: hoy gran parte de lo conservador (money market, plazo fijo, dólar) puede dar rendimiento real NEGATIVO; los instrumentos CER o ciertas acciones suelen ser la opción con real positivo. No sobrevendas.

FORMATO (markdown, español rioplatense, claro y conciso):
- Usá tablas markdown para comparar instrumentos.
- Cuando un gráfico ayude (ej. una serie histórica), incluí UN bloque de código con lenguaje "chart" y dentro un JSON así:
  \`\`\`chart
  {"type":"line","title":"GGAL — cierre $","labels":["2025-01","..."],"data":[6500,7000]}
  \`\`\`
  (type "bar" o "line"; labels y data de igual largo; un solo gráfico por respuesta).
- Cerrá las recomendaciones con: "_No es asesoramiento financiero formal; los rendimientos pasados no garantizan los futuros._"`;

async function buildBaseContext(userId: string): Promise<string> {
  const [infl, macro, comp, perfil, cartera] = await Promise.all([
    sbGet(`inflacion?select=mensual,interanual,fecha&order=fecha.desc&limit=1`),
    sbGet(`panel_macro?select=*`),
    sbGet(`comparador_instrumentos?select=instrumento,detalle,nominal_anual,real_anual`),
    sbGet(`ai_perfil?usuario_id=eq.${userId}&select=monto_disponible,moneda,horizonte,tolerancia,objetivo,notas,updated_at`),
    sbGet(`ai_cartera?usuario_id=eq.${userId}&select=instrumento,tipo,monto,moneda,fecha_inicio,fecha_fin,rendimiento_pct,activo,notas&order=activo.desc`),
  ]);
  const ctx = {
    fecha: new Date().toISOString().slice(0, 10),
    inflacion: infl[0] ?? null,
    panorama_macro: macro[0] ?? null,
    comparador_instrumentos: comp,
    perfil_inversor: perfil[0] ?? null,
    cartera_del_inversor: cartera,
  };
  return "CONTEXTO BASE (snapshot del día; para detalle de instrumentos, rankings, series, money market o plazo fijo usá las herramientas):\n" +
    JSON.stringify(ctx, null, 1);
}

// ───────────────────────── Adaptadores por proveedor ─────────────────────────
const OPENAI_TOOLS = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
const ANTHROPIC_TOOLS = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

type ToolCall = { id: string; name: string; argStr: string };
type RoundResult = { toolCalls: ToolCall[]; assistantContent: string };

function buildRequest(conf: ReturnType<typeof providerConf>, msgs: any[], baseContext: string, noTools = false) {
  if (conf.name === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${conf.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: conf.model, stream: true, stream_options: { include_usage: true },
        max_completion_tokens: 4000, tools: OPENAI_TOOLS, tool_choice: noTools ? "none" : "auto",
        messages: [{ role: "system", content: SYSTEM_PROMPT + "\n\n" + baseContext }, ...msgs],
      }),
    };
  }
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": conf.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: conf.model, max_tokens: 4000, stream: true,
      ...(noTools ? {} : { tools: ANTHROPIC_TOOLS }),
      system: [{ type: "text", text: SYSTEM_PROMPT }, { type: "text", text: baseContext, cache_control: { type: "ephemeral" } }],
      messages: msgs,
    }),
  };
}

async function parseOpenAIRound(body: ReadableStream<Uint8Array>, onToken: (t: string) => void, usage: any): Promise<RoundResult> {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  const tcs: Record<number, ToolCall> = {}; let content = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim(); if (!p || p === "[DONE]") continue;
      let evt: any; try { evt = JSON.parse(p); } catch { continue; }
      const ch = evt.choices?.[0];
      if (ch) {
        const d = ch.delta ?? {};
        if (d.content) { content += d.content; onToken(d.content); }
        if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) {
          const i = t.index ?? 0;
          tcs[i] = tcs[i] ?? { id: "", name: "", argStr: "" };
          if (t.id) tcs[i].id = t.id;
          if (t.function?.name) tcs[i].name = t.function.name;
          if (t.function?.arguments) tcs[i].argStr += t.function.arguments;
        }
      }
      if (evt.usage) {
        usage.input += evt.usage.prompt_tokens ?? 0;
        usage.output += evt.usage.completion_tokens ?? 0;
        usage.cacheRead += evt.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
    }
  }
  const toolCalls = Object.keys(tcs).map((k) => tcs[+k]).filter((t) => t.name);
  return { toolCalls, assistantContent: content };
}

async function parseAnthropicRound(body: ReadableStream<Uint8Array>, onToken: (t: string) => void, usage: any): Promise<RoundResult> {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  const blocks: Record<number, any> = {}; let content = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim(); if (!p) continue;
      let evt: any; try { evt = JSON.parse(p); } catch { continue; }
      if (evt.type === "message_start" && evt.message?.usage) {
        const u = evt.message.usage;
        usage.input += u.input_tokens ?? 0;
        usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
        usage.cacheRead += u.cache_read_input_tokens ?? 0;
      } else if (evt.type === "content_block_start") {
        blocks[evt.index] = { ...evt.content_block, _json: "" };
      } else if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta") { content += evt.delta.text; onToken(evt.delta.text); }
        else if (evt.delta?.type === "input_json_delta" && blocks[evt.index]) blocks[evt.index]._json += evt.delta.partial_json ?? "";
      } else if (evt.type === "message_delta" && evt.usage?.output_tokens != null) {
        usage.output += evt.usage.output_tokens;
      }
    }
  }
  const toolCalls = Object.values(blocks).filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, argStr: b._json || "{}" }));
  return { toolCalls, assistantContent: content };
}

// Apila en `msgs` (formato nativo del proveedor) la respuesta del asistente + los resultados de las tools.
function appendToolRound(conf: ReturnType<typeof providerConf>, msgs: any[], r: RoundResult, results: { tc: ToolCall; result: unknown }[]) {
  if (conf.name === "openai") {
    msgs.push({ role: "assistant", content: r.assistantContent || null, tool_calls: r.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.argStr || "{}" } })) });
    for (const { tc, result } of results) msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
  } else {
    const blocks: any[] = [];
    if (r.assistantContent) blocks.push({ type: "text", text: r.assistantContent });
    for (const tc of r.toolCalls) { let input = {}; try { input = JSON.parse(tc.argStr || "{}"); } catch { /* */ } blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input }); }
    msgs.push({ role: "assistant", content: blocks });
    msgs.push({ role: "user", content: results.map(({ tc, result }) => ({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(result) })) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const conf = providerConf();
  if (!conf.key) return json({ error: `Falta configurar ${conf.keyName} en el servidor.` }, 500);

  const clave = req.headers.get("x-portal-key");
  if (!clave) return json({ error: "Clave inválida." }, 401);
  const hash = await sha256hex(clave);
  const users = await sbGet(`ai_usuarios?clave_hash=eq.${hash}&activo=is.true&select=id,nombre,rol,limite_usd,periodo`);
  const user = users[0];
  if (!user) return json({ error: "Clave inválida o inactiva." }, 401);

  const cons = await sbGet(`ai_consumo_periodo?usuario_id=eq.${user.id}&select=consumo_usd,limite_usd`);
  const consumo = Number(cons[0]?.consumo_usd ?? 0);
  if (consumo >= Number(user.limite_usd)) {
    return json({ error: `Alcanzaste tu límite de consumo (US$${Number(user.limite_usd).toFixed(2)}). Contactá a dirección.` }, 402);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const incoming: any[] = Array.isArray(body.messages) ? body.messages : [];
  if (!incoming.length) return json({ error: "Sin mensajes." }, 400);
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const lastUserText = lastUser?.content ?? "";

  let conversacionId: string = body.conversacion_id ?? "";
  if (!conversacionId) {
    const ins = await sbInsert("ai_conversaciones", { usuario_id: user.id, titulo: String(lastUserText).slice(0, 60) || "Consulta" }, true);
    conversacionId = ins[0].id;
  }

  const baseContext = await buildBaseContext(user.id);
  // Historial nativo: roles user/assistant con contenido string.
  const hist = incoming.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
  const msgs: any[] = [...hist];

  const usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  let assistantText = "";

  async function record() {
    const costo = costOf(conf.model, usage, conf.name);
    try {
      const mensajes: any[] = [{ conversacion_id: conversacionId, rol: "user", contenido: String(lastUserText) }];
      if (assistantText.trim()) mensajes.push({ conversacion_id: conversacionId, rol: "assistant", contenido: assistantText });
      await sbInsert("ai_mensajes", mensajes);
      await sbInsert("ai_uso", {
        usuario_id: user.id, conversacion_id: conversacionId, modelo: `${conf.name}:${conf.model}`,
        input_tokens: usage.input, output_tokens: usage.output,
        cache_creation_tokens: usage.cacheCreate, cache_read_tokens: usage.cacheRead,
        costo_usd: Number(costo.toFixed(6)),
      });
    } catch (_e) { /* no romper por el log */ }
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      // Streamea en vivo; NO acumula en assistantText (la respuesta final se fija al cerrar el loop,
      // así el preámbulo de rondas con tool_calls no contamina lo que se persiste).
      const onToken = (t: string) => emit({ t: "token", v: t });
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const lastRound = round === MAX_ROUNDS - 1;
          const reqData = buildRequest(conf, msgs, baseContext, lastRound);
          const upstream = await fetch(reqData.url, { method: "POST", headers: reqData.headers, body: reqData.body });
          if (!upstream.ok || !upstream.body) {
            const detail = await upstream.text().catch(() => "");
            emit({ t: "error", v: "Error al consultar el modelo.", detail: detail.slice(0, 300) });
            break;
          }
          const r = conf.name === "openai"
            ? await parseOpenAIRound(upstream.body, onToken, usage)
            : await parseAnthropicRound(upstream.body, onToken, usage);

          if (r.toolCalls.length && !lastRound) {
            // El modelo pudo haber streameado preámbulo ("voy a consultar...") antes de las tools:
            // pedirle al navegador que descarte lo mostrado en esta ronda.
            if (r.assistantContent) emit({ t: "reset" });
            const results: { tc: ToolCall; result: unknown }[] = [];
            for (const tc of r.toolCalls) {
              let parsed: any = {}; try { parsed = JSON.parse(tc.argStr || "{}"); } catch { /* */ }
              emit({ t: "tool", name: tc.name, arg: shortArg(parsed) });
              const result = await runTool(tc.name, parsed, { user, conversacionId });
              results.push({ tc, result });
            }
            appendToolRound(conf, msgs, r, results);
            // Cortar si el costo acumulado ya alcanzó el límite (acota el overshoot multi-ronda).
            if (consumo + costOf(conf.model, usage, conf.name) >= Number(user.limite_usd)) {
              emit({ t: "error", v: "Se alcanzó el límite de consumo durante la consulta." });
              break;
            }
            continue; // otra ronda con los resultados
          }
          assistantText = r.assistantContent; // respuesta final (ya streameada en vivo)
          break;
        }
      } catch (_e) {
        emit({ t: "error", v: "Error interno del asesor." });
      }
      await record();
      emit({ t: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "application/x-ndjson; charset=utf-8", "x-conversacion-id": conversacionId },
  });
});
