// asesor-ia — chat del Asesor de Inversiones con snapshot de mercado + cartera del inversor.
// Agnóstico de proveedor: AI_PROVIDER = "anthropic" (Claude, default) | "openai".
// Streaming al navegador y medición de consumo (USD) por usuario.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SB_URL}/rest/v1`;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

const PROVIDER = (Deno.env.get("AI_PROVIDER") ?? "anthropic").toLowerCase();

// USD por 1M tokens [input, output]. OpenAI: valores aproximados (cutoff mediados 2025) —
// verificá en la página de precios de OpenAI y ajustá esta tabla si hace falta.
const PRICES: Record<string, [number, number]> = {
  // Anthropic
  "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25],
  "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [1, 5],
  // OpenAI (aprox.)
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
    // prompt_tokens YA incluye los cacheados; los cacheados se facturan ~50% del input
    const cached = u.cacheRead || 0;
    const fresh = Math.max(0, u.input - cached);
    return fresh / 1e6 * pIn + cached / 1e6 * pIn * 0.5 + u.output / 1e6 * pOut;
  }
  // anthropic: input_tokens NO incluye cacheados; write 1.25x, read 0.1x
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

const SYSTEM_PROMPT = `Sos el Asesor de Inversiones de Montagne, un asistente financiero para el mercado argentino. Tu trabajo es ayudar a un inversor a decidir dónde colocar su dinero, con honestidad y respaldado en datos.

REGLAS:
- Razoná SIEMPRE en términos REALES (netos de inflación). En Argentina una tasa nominal alta puede ser un rendimiento real negativo. Es el dato clave.
- Usá EXCLUSIVAMENTE los números del bloque DATOS DE MERCADO que recibís (TNA, % real, fechas, cotizaciones). No inventes cifras ni cites valores de tu memoria. Si un dato no está, decilo.
- Para recomendar dónde invertir necesitás conocer el perfil del inversor: monto disponible, horizonte temporal, tolerancia al riesgo y moneda objetivo. Si no surge del historial de cartera ni de la conversación, PREGUNTÁ esos datos de forma natural antes de recomendar.
- Usá el historial de cartera del inversor para contextualizar: qué ya tiene, cómo está diversificado, qué le rindió. Señalá concentraciones de riesgo.
- Fundamentá cada propuesta citando los números concretos (por ej. "Plazo fijo Banco X: TNA 35% → real -7% i.a." con la fecha del dato).
- Sé honesto: hoy gran parte de lo conservador (money market, plazo fijo, dólar) puede dar rendimiento real NEGATIVO; los bonos CER suelen ser la opción con real positivo. No sobrevendas.

FORMATO DE RESPUESTA (markdown):
- Respondé en español rioplatense, claro y conciso.
- Usá tablas markdown para comparar instrumentos.
- Cuando un gráfico ayude, incluí UN bloque de código con lenguaje "chart" y dentro un JSON con esta forma:
  \`\`\`chart
  {"type":"bar","title":"Rendimiento real anual (%)","labels":["Bono CER","Plazo Fijo","Money Market"],"data":[8,-7,-9]}
  \`\`\`
  (type puede ser "bar" o "line"; labels y data son arrays de igual largo). No pongas más de un gráfico por respuesta.
- Cerrá las recomendaciones con: "_No es asesoramiento financiero formal; los rendimientos pasados no garantizan los futuros._"`;

async function buildDataPack(usuarioId: string): Promise<string> {
  const peso = encodeURIComponent("Peso Argentina");
  const clasico = encodeURIComponent("Clásico");
  const [macro, comp, fondos, infl, pf, cartera, accRend, cedRend] = await Promise.all([
    sbGet(`panel_macro?select=*`),
    sbGet(`comparador_instrumentos?select=instrumento,detalle,nominal_anual,real_anual`),
    sbGet(
      `cafci_fondos_latest?moneda_nombre=eq.${peso}&tipo_dinero=eq.${clasico}` +
        `&select=fondo_nombre,sociedad,tna_mes_1,tna_real,real_30d,patrimonio_neto,fecha_base` +
        `&order=patrimonio_neto.desc&limit=15`,
    ),
    sbGet(`inflacion?select=mensual,interanual,fecha&order=fecha.desc&limit=1`),
    sbGet(`plazo_fijo?select=entidad,tna_clientes,fecha&order=fecha.desc,tna_clientes.desc&limit=60`),
    sbGet(
      `ai_cartera?usuario_id=eq.${usuarioId}` +
        `&select=instrumento,tipo,monto,moneda,fecha_inicio,fecha_fin,rendimiento_pct,activo,notas`,
    ),
    sbGet(`cotizaciones_rendimientos?tipo=eq.accion&order=vol.desc.nullslast&select=symbol,px,var_30d,var_90d,var_12m&limit=10`),
    sbGet(`cotizaciones_rendimientos?tipo=eq.cedear&order=vol.desc.nullslast&select=symbol,px,var_30d,var_90d,var_12m&limit=10`),
  ]);

  const pfFecha = pf[0]?.fecha;
  const pfLatest = pf.filter((r) => r.fecha === pfFecha).slice(0, 10);

  const pack = {
    fecha_consulta: new Date().toISOString().slice(0, 10),
    inflacion: infl[0] ?? null,
    panorama_macro: macro[0] ?? null,
    comparador_instrumentos: comp,
    money_market_top: fondos.map((f) => ({
      fondo: f.fondo_nombre, sociedad: f.sociedad,
      tna_30d: f.tna_mes_1, tna_real_ia: f.tna_real, real_mensual: f.real_30d,
      patrimonio_millones: f.patrimonio_neto != null ? Math.round(f.patrimonio_neto / 1e6) : null,
    })),
    plazo_fijo_top: pfLatest,
    cartera_del_inversor: cartera,
    historico_nota: "var_30d/90d/12m = variación NOMINAL del precio en pesos (incluye inflación y devaluación). Comparar contra la inflación interanual para leer el real.",
    acciones_top: accRend,
    cedears_top: cedRend,
  };

  return "DATOS DE MERCADO (snapshot actual; usá solo estos números):\n" + JSON.stringify(pack, null, 1);
}

function buildUpstream(conf: ReturnType<typeof providerConf>, messages: any[], dataPack: string) {
  const hist = messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
  if (conf.name === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: { Authorization: `Bearer ${conf.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: conf.model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 8000,
        messages: [{ role: "system", content: SYSTEM_PROMPT + "\n\n" + dataPack }, ...hist],
      }),
    };
  }
  return {
    url: "https://api.anthropic.com/v1/messages",
    headers: { "x-api-key": conf.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: conf.model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      stream: true,
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: dataPack, cache_control: { type: "ephemeral" } },
      ],
      messages: hist,
    }),
  };
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
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json({ error: "Sin mensajes." }, 400);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserText = lastUser?.content ?? "";

  let conversacionId: string = body.conversacion_id ?? "";
  if (!conversacionId) {
    const ins = await sbInsert("ai_conversaciones", { usuario_id: user.id, titulo: String(lastUserText).slice(0, 60) || "Consulta" }, true);
    conversacionId = ins[0].id;
  }

  const dataPack = await buildDataPack(user.id);
  const up = buildUpstream(conf, messages, dataPack);

  const upstream = await fetch(up.url, { method: "POST", headers: up.headers, body: up.body });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "Error al consultar el modelo.", detail }, 502);
  }

  const usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  let assistantText = "";

  async function record() {
    const costo = costOf(conf.model, usage, conf.name);
    try {
      await sbInsert("ai_mensajes", [
        { conversacion_id: conversacionId, rol: "user", contenido: String(lastUserText) },
        { conversacion_id: conversacionId, rol: "assistant", contenido: assistantText },
      ]);
      await sbInsert("ai_uso", {
        usuario_id: user.id, conversacion_id: conversacionId, modelo: `${conf.name}:${conf.model}`,
        input_tokens: usage.input, output_tokens: usage.output,
        cache_creation_tokens: usage.cacheCreate, cache_read_tokens: usage.cacheRead,
        costo_usd: Number(costo.toFixed(6)),
      });
    } catch (_e) { /* no romper el stream por el log */ }
  }

  const isOpenAI = conf.name === "openai";
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let evt: any;
            try { evt = JSON.parse(payload); } catch { continue; }

            if (isOpenAI) {
              const delta = evt.choices?.[0]?.delta?.content;
              if (delta) { assistantText += delta; controller.enqueue(enc.encode(delta)); }
              if (evt.usage) {
                usage.input = evt.usage.prompt_tokens ?? 0;
                usage.output = evt.usage.completion_tokens ?? 0;
                usage.cacheRead = evt.usage.prompt_tokens_details?.cached_tokens ?? 0;
                usage.cacheCreate = 0;
              }
            } else {
              if (evt.type === "message_start" && evt.message?.usage) {
                const u = evt.message.usage;
                usage.input = u.input_tokens ?? 0;
                usage.cacheCreate = u.cache_creation_input_tokens ?? 0;
                usage.cacheRead = u.cache_read_input_tokens ?? 0;
                usage.output = u.output_tokens ?? 0;
              } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                assistantText += evt.delta.text;
                controller.enqueue(enc.encode(evt.delta.text));
              } else if (evt.type === "message_delta" && evt.usage?.output_tokens != null) {
                usage.output = evt.usage.output_tokens;
              }
            }
          }
        }
      } catch (_e) { /* upstream cortado */ }
      await record();
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8", "x-conversacion-id": conversacionId },
  });
});
