/**
 * Cliente + parser para el endpoint JSON "no oficial" de Vatican News:
 *   ES: https://www.vaticannews.va/es/evangelio-de-hoy/YYYY/MM/DD.speech.js
 *   EN: https://www.vaticannews.va/en/word-of-the-day/YYYY/MM/DD.speech.js
 *
 * Ambos devuelven la misma forma de JSON (letturaText, vangeloText, hfwText),
 * pero con maquetación distinta dentro del HTML:
 *
 *  - ES: "Primera lectura" / "Segunda lectura" como <p> propio, luego
 *        "Lectura del libro de..." en otro <p>, luego la cita en otro <p>.
 *  - EN: sin label de "First/Second reading"; el libro y la cita vienen
 *        juntos en el mismo <p>, separados por <br> (ej: "A reading from
 *        the Book of Isaiah<br/>55:10-11").
 *
 * NOTA: el salmo responsorial NO viene en ningún idioma de este endpoint.
 * Verificado en ES y EN para domingos (con segunda lectura) y no aparece
 * en ningún campo.
 *
 * Pensado para correr tanto en Node.js como en Cloudflare Workers
 * (usa fetch nativo, sin axios).
 */

import * as cheerio from "cheerio";

export type Locale = "es" | "en";

export interface ReadingSection {
  etiqueta: string | null;
  libro: string | null;
  cita: string | null;
  texto: string[];
}

export interface VaticanReadings {
  fecha: string;
  locale: Locale;
  url: string;
  primeraLectura: ReadingSection | null;
  salmo: null;
  segundaLectura: ReadingSection | null;
  evangelio: ReadingSection | null;
  reflexionPapal: string | null;
}

interface SpeechResponse {
  speech?: Array<{
    letturaText?: string;
    vangeloText?: string;
    hfwText?: string;
  }>;
}

interface LocaleConfig {
  baseUrl: string;
  /** Etiqueta de sección como párrafo propio (solo ES). null si el idioma no la trae. */
  labelRegex: RegExp | null;
  /** Detecta el párrafo que introduce una lectura o el evangelio. */
  introRegex: RegExp;
  /** Etiquetas por defecto si el idioma no las trae explícitas (ej. EN). */
  defaultLabels: [string, string];
}

const LOCALES: Record<Locale, LocaleConfig> = {
  es: {
    baseUrl: "https://www.vaticannews.va/es/evangelio-de-hoy",
    labelRegex: /^(Primera|Segunda) lectura$/i,
    introRegex: /^Lectura (del|de la)/i,
    defaultLabels: ["Primera lectura", "Segunda lectura"],
  },
  en: {
    baseUrl: "https://www.vaticannews.va/en/word-of-the-day",
    labelRegex: null,
    introRegex: /^(A reading from|From the Gospel according to)/i,
    defaultLabels: ["First reading", "Second reading"],
  },
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function buildSpeechUrl(
  locale: Locale,
  date: Date = new Date(),
): { url: string; yyyy: string; mm: string; dd: string } {
  const cfg = LOCALES[locale];
  const yyyy = String(date.getFullYear());
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  return { url: `${cfg.baseUrl}/${yyyy}/${mm}/${dd}.speech.js`, yyyy, mm, dd };
}

/** Convierte HTML a texto plano, preservando <br> como salto de línea y normalizando &nbsp;. */
function htmlToPlain(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  const $ = cheerio.load(`<div>${withBreaks}</div>`);
  return $("div")
    .text()
    .replace(/\u00A0/g, " ")
    .trim();
}

/** Aplica un formateo ligero (negrita/cursiva -> markdown) y limpia el HTML. */
function htmlToFormattedPlain(html: string): string {
  const withMarkers = html
    .replace(/<i>(.*?)<\/i>/gis, "_$1_")
    .replace(/<b>(.*?)<\/b>/gis, "**$1**")
    .replace(/<strong>(.*?)<\/strong>/gis, "**$1**")
    .replace(/<br\s*\/?>/gi, "\n");
  return htmlToPlain(withMarkers);
}

/** Heurística: ¿esta línea corta parece una cita bíblica (y no un libro o cuerpo)? */
function looksLikeCitation(line: string): boolean {
  if (line.length >= 40) return false;
  const bareNumeric = /^\d+[:,]\s*\d/; // "55:10-11"
  const withBookName = /^[A-ZÀ-ÿ][\wÀ-ÿ]*\s.*\d/; // "Isaías 55, 10-11" / "Romans 8:18-23"
  return bareNumeric.test(line) || withBookName.test(line);
}

/**
 * Parsea un fragmento HTML (letturaText o vangeloText) en una o más
 * "lecturas", detectando límites de sección tanto por etiqueta explícita
 * (ES) como por el inicio de un nuevo párrafo introductorio (EN).
 */
function parseSections(html: string, cfg: LocaleConfig): ReadingSection[] {
  const $ = cheerio.load(`<div>${html}</div>`);
  const rawParagraphs = $("div")
    .find("p")
    .map((_, el) => $.html(el).replace(/^<p[^>]*>|<\/p>$/gi, ""))
    .get();

  const sections: ReadingSection[] = [];
  let current: ReadingSection | null = null;

  for (const raw of rawParagraphs) {
    const plain = htmlToPlain(raw);
    if (!plain) continue; // párrafos vacíos tipo "&nbsp;" separan secciones

    // 1. Etiqueta de sección explícita (solo ES: "Primera lectura", etc.)
    if (cfg.labelRegex && cfg.labelRegex.test(plain) && plain.length < 40) {
      current = { etiqueta: plain, libro: null, cita: null, texto: [] };
      sections.push(current);
      continue;
    }

    const lines = plain
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // 2. Párrafo introductorio de lectura/evangelio
    if (lines.length > 0 && cfg.introRegex.test(lines[0])) {
      const needsNewSection =
        !current || current.texto.length > 0 || current.libro;
      if (needsNewSection) {
        current = { etiqueta: null, libro: null, cita: null, texto: [] };
        sections.push(current);
      }
      current!.libro = lines[0];
      if (lines.length > 1 && looksLikeCitation(lines[1])) {
        current!.cita = lines[1];
      }
      continue;
    }

    // 3. Cita en párrafo separado (patrón ES cuando no viene junto al libro)
    if (
      current &&
      current.libro &&
      !current.cita &&
      lines.length === 1 &&
      looksLikeCitation(lines[0])
    ) {
      current.cita = lines[0];
      continue;
    }

    // 4. Cuerpo del texto
    if (!current) {
      current = { etiqueta: null, libro: null, cita: null, texto: [] };
      sections.push(current);
    }
    const formatted = htmlToFormattedPlain(raw);
    if (formatted) current.texto.push(formatted);
  }

  return sections;
}

/** Aplica etiquetas por defecto ("First reading"/"Second reading") solo a las lecturas, nunca al evangelio. */
function applyDefaultLabels(
  sections: ReadingSection[],
  cfg: LocaleConfig,
): void {
  sections.forEach((s, i) => {
    if (!s.etiqueta && cfg.defaultLabels[i]) {
      s.etiqueta = cfg.defaultLabels[i];
    }
  });
}

/**
 * Obtiene y parsea las lecturas del día indicado (por defecto, hoy) en el
 * idioma indicado (por defecto, español).
 */
export async function getVaticanReadings(
  date: Date = new Date(),
  locale: Locale = "es",
): Promise<VaticanReadings> {
  const cfg = LOCALES[locale];
  const { url, yyyy, mm, dd } = buildSpeechUrl(locale, date);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      Accept: "application/json,text/javascript,*/*",
    },
  });

  if (!res.ok) {
    throw new Error(`Vatican News respondió ${res.status} para ${url}`);
  }

  const data = (await res.json()) as SpeechResponse;
  const item = data?.speech?.[0];

  if (!item) {
    throw new Error("Respuesta inesperada: no se encontró data.speech[0]");
  }

  const lecturas = parseSections(item.letturaText ?? "", cfg);
  applyDefaultLabels(lecturas, cfg);
  const [primeraLectura = null, segundaLectura = null] = lecturas;

  const evangelioArr = parseSections(item.vangeloText ?? "", cfg);
  const evangelio = evangelioArr[0] ?? null;
  if (evangelio) evangelio.etiqueta = null; // el campo "evangelio" ya es autodescriptivo

  const reflexionPapal = htmlToFormattedPlain(item.hfwText ?? "") || null;

  return {
    fecha: `${yyyy}-${mm}-${dd}`,
    locale,
    url,
    primeraLectura,
    salmo: null, // No publicado por Vatican News en ningún idioma/endpoint conocido
    segundaLectura,
    evangelio,
    reflexionPapal,
  };
}
