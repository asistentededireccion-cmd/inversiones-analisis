import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const API_URL = "https://estadisticas.cafci.org.ar/v2/fondos-mercado-de-dinero.json";

// Mapeo periodo (clave en la API) -> sufijo de columnas en cafci_fondos
const PERIODOS: Record<string, { tna: string; dir: string }> = {
  dia:      { tna: "tna_dia",   dir: "dir_dia" },
  dias_7:   { tna: "tna_7d",    dir: "dir_7d" },
  mes_1:    { tna: "tna_mes_1", dir: "dir_mes_1" },
  dias_90:  { tna: "tna_90d",   dir: "dir_90d" },
  dias_180: { tna: "tna_180d",  dir: "dir_180d" },
  meses_12: { tna: "tna_12m",   dir: "dir_12m" },
  ytd:      { tna: "tna_ytd",   dir: "dir_ytd" },
};

// Convierte "" / null / undefined a null; el resto a Number
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

Deno.serve(async (req: Request) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Traer el JSON de CAFCI
    const res = await fetch(API_URL, { headers: { accept: "application/json" } });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: `CAFCI respondio ${res.status}` }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
    const data = await res.json();
    const clases: any[] = Array.isArray(data.clases) ? data.clases : [];

    // 2) Upsert del snapshot (idempotente por fecha_base)
    const { data: snap, error: snapErr } = await supabase
      .from("cafci_snapshots")
      .upsert(
        {
          fecha_base: data.fecha_base,
          generated_at: data.generated_at,
          total_clases: data.total_clases ?? clases.length,
          clases_guardadas: clases.length,
          periodos: data.periodos ?? null,
          fechas_disponibles: data.fechas_disponibles ?? null,
          source_url: API_URL,
          captured_at: new Date().toISOString(),
        },
        { onConflict: "fecha_base" },
      )
      .select("id, fecha_base")
      .single();

    if (snapErr) throw snapErr;

    // 3) Aplanar cada clase a una fila de cafci_fondos
    const rows = clases.map((c) => {
      const r = c.rendimientos ?? {};
      const flat: Record<string, number | null> = {};
      for (const [key, cols] of Object.entries(PERIODOS)) {
        const p = r[key] ?? {};
        flat[cols.tna] = num(p?.tna);
        flat[cols.dir] = num(p?.directo);
      }
      return {
        snapshot_id: snap.id,
        fecha_base: snap.fecha_base,
        clase_id: c.clase_id,
        fondo_id: c.fondo_id ?? null,
        sociedad: c.sociedad ?? null,
        moneda_id: c.moneda_id ?? null,
        moneda_nombre: c.moneda_nombre ?? null,
        tipo_dinero: c.tipo_dinero ?? null,
        clase_nombre: c.clase_nombre ?? null,
        fondo_nombre: c.fondo_nombre ?? null,
        fecha_valor: c.fecha_valor ?? null,
        patrimonio_neto: num(c.patrimonio_neto),
        valor_cuotaparte: num(c.valor_cuotaparte),
        ...flat,
        rendimientos: c.rendimientos ?? null,
      };
    });

    // 4) Upsert del detalle (idempotente por snapshot_id + clase_id)
    let guardadas = 0;
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const { error: rowErr } = await supabase
        .from("cafci_fondos")
        .upsert(slice, { onConflict: "snapshot_id,clase_id" });
      if (rowErr) throw rowErr;
      guardadas += slice.length;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        snapshot_id: snap.id,
        fecha_base: snap.fecha_base,
        generated_at: data.generated_at,
        total_clases: data.total_clases ?? clases.length,
        clases_guardadas: guardadas,
      }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
});
