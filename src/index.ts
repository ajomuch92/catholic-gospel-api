import { Hono } from "hono";
import { getVaticanReadings, type Locale } from "./vaticanSpeech";
import { cors } from "hono/cors";

const app = new Hono();

function parseDateParam(fecha?: string): Date {
  if (!fecha) return new Date();
  const [y, m, d] = fecha.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error("Formato de fecha inválido, usa YYYY-MM-DD");
  }
  return new Date(y, m - 1, d);
}

function parseLocaleParam(locale?: string): Locale {
  if (!locale) return "es";
  if (locale === "es" || locale === "en") return locale;
  throw new Error('Idioma inválido, usa "es" o "en"');
}

// GET /lecturas                      -> lecturas de hoy en español
// GET /lecturas/2026-07-12           -> lecturas de una fecha en español
// GET /lecturas/2026-07-12?lang=en   -> lecturas de una fecha en inglés
app.get(
  "/lecturas/:fecha?",
  cors({
    origin: "*",
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type"],
  }),
  async (c) => {
    try {
      const date = parseDateParam(c.req.param("fecha"));
      const locale = parseLocaleParam(c.req.query("lang"));
      const lecturas = await getVaticanReadings(date, locale);
      return c.json(lecturas);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      const status = message.startsWith("Vatican News respondió") ? 502 : 400;
      return c.json({ error: message }, status);
    }
  },
);

app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
