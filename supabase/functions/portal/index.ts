// portal — datos del usuario del Asesor IA (login, cartera, consumo).
// Auth propia por clave privada (header x-portal-key); sin JWT.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SVC = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REST = `${SB_URL}/rest/v1`;
const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, "Content-Type": "application/json" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-portal-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function authUser(req: Request) {
  const clave = req.headers.get("x-portal-key");
  if (!clave) return null;
  const hash = await sha256hex(clave);
  const rows = await sbGet(
    `ai_usuarios?clave_hash=eq.${hash}&activo=is.true&select=id,nombre,rol,limite_usd,periodo`,
  );
  return rows[0] ?? null;
}

async function consumoDe(usuarioId: string) {
  const rows = await sbGet(
    `ai_consumo_periodo?usuario_id=eq.${usuarioId}&select=consumo_usd,limite_usd,periodo,requests`,
  );
  return rows[0] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const user = await authUser(req);
  if (!user) return json({ error: "Clave inválida o inactiva." }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* sin body */ }
  const action = body.action ?? "login";

  if (action === "login") {
    const c = await consumoDe(user.id);
    return json({
      nombre: user.nombre, rol: user.rol, limite_usd: user.limite_usd,
      periodo: user.periodo, consumo_usd: c?.consumo_usd ?? 0,
    });
  }

  if (action === "consumo") {
    if (user.rol === "direccion") {
      const usuarios = await sbGet(
        `ai_consumo_periodo?select=usuario_id,nombre,rol,limite_usd,periodo,consumo_usd,requests&order=consumo_usd.desc`,
      );
      return json({ rol: "direccion", usuarios });
    }
    const c = await consumoDe(user.id);
    return json({ rol: user.rol, consumo_usd: c?.consumo_usd ?? 0, limite_usd: user.limite_usd, periodo: user.periodo });
  }

  if (action === "cartera_list") {
    const items = await sbGet(
      `ai_cartera?usuario_id=eq.${user.id}&select=*&order=activo.desc,fecha_inicio.desc`,
    );
    return json({ items });
  }

  if (action === "cartera_add") {
    const it = body.item ?? {};
    if (!it.instrumento) return json({ error: "Falta el nombre del instrumento." }, 400);
    const row = {
      usuario_id: user.id,
      instrumento: String(it.instrumento),
      tipo: it.tipo ?? "otro",
      monto: it.monto === "" || it.monto == null ? null : Number(it.monto),
      moneda: it.moneda ?? "ARS",
      fecha_inicio: it.fecha_inicio || null,
      fecha_fin: it.fecha_fin || null,
      rendimiento_pct: it.rendimiento_pct === "" || it.rendimiento_pct == null ? null : Number(it.rendimiento_pct),
      activo: it.activo !== false,
      notas: it.notas || null,
    };
    const r = await fetch(`${REST}/ai_cartera`, {
      method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row),
    });
    if (!r.ok) return json({ error: await r.text() }, 400);
    const ins = await r.json();
    return json({ item: ins[0] });
  }

  if (action === "cartera_delete") {
    if (body.id == null) return json({ error: "Falta id." }, 400);
    await fetch(`${REST}/ai_cartera?id=eq.${encodeURIComponent(body.id)}&usuario_id=eq.${user.id}`, {
      method: "DELETE", headers: H,
    });
    return json({ ok: true });
  }

  return json({ error: "Acción desconocida." }, 400);
});
