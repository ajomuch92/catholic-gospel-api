/**
 * Cliente + parser para el endpoint JSON "no oficial" de Vatican News:
 *   https://www.vaticannews.va/es/evangelio-de-hoy/YYYY/MM/DD.speech.js
 *
 * Este endpoint devuelve JSON puro (usado internamente por el sitio para
 * el texto-a-voz), con:
 *   - letturaText: HTML con primera lectura y (domingos/solemnidades) segunda
 *   - vangeloText: HTML con el evangelio
 *   - hfwText: HTML con la reflexión/catequesis papal
 *
 * NOTA: el salmo responsorial NO viene en este endpoint tampoco.
 * Lo verifiqué con el domingo 12/07/2026 (que sí trae segunda lectura) y
 * sigue sin aparecer el salmo en ningún campo.
 *
 * Escrito para funcionar tanto en Node.js como en Cloudflare Workers
 * (usa fetch nativo, sin axios).
 */

import * as cheerio from "cheerio";

const BASE_URL = "https://www.vaticannews.va/es/evangelio-de-hoy";

function pad(n: string | number) {
  return String(n).padStart(2, "0");
}

export function buildSpeechUrl(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  return { url: `${BASE_URL}/${yyyy}/${mm}/${dd}.speech.js`, yyyy, mm, dd };
}

/**
 * Recorre los <p> de un fragmento HTML y los agrupa en "lecturas".
 * Cada vez que encuentra un <p> que coincide con un label conocido
 * ("Primera lectura" / "Segunda lectura") abre una lectura nueva.
 * Si el fragmento no trae label (como vangeloText), todo se trata
 * como una sola lectura.
 */
function parseReadingsHtml(
  $: cheerio.CheerioAPI,
  html: string,
  labelRegex: RegExp | null,
) {
  const $frag = $("<div>").html(html);
  const paragraphs = $frag
    .find("p")
    .map((_, el) => $(el).html()?.trim())
    .get()
    .filter(Boolean);

  const readings: Array<{
    etiqueta: string | null;
    libro: string | null;
    cita: string | null;
    texto: string[];
  }> = [];
  let current: {
    etiqueta: string | null;
    libro: string | null;
    cita: string | null;
    texto: string[];
  } | null = null;

  for (const raw of paragraphs) {
    // Texto plano (sin tags) para detectar labels y encabezados cortos
    const plain = cheerio.load(`<div>${raw}</div>`)("div").text().trim();

    if (labelRegex && labelRegex.test(plain) && plain.length < 40) {
      current = { etiqueta: plain, libro: null, cita: null, texto: [] };
      readings.push(current);
      continue;
    }

    if (!current) {
      current = { etiqueta: null, libro: null, cita: null, texto: [] };
      readings.push(current);
    }

    if (!current.libro && /^Lectura (del|de la)/i.test(plain)) {
      current.libro = plain;
      continue;
    }

    if (
      !current.cita &&
      current.libro &&
      plain.length < 40 &&
      /\d/.test(plain)
    ) {
      current.cita = plain;
      continue;
    }

    // Preservamos negritas/cursivas simples como markdown ligero
    const conFormato = raw
      .replace(/<i>(.*?)<\/i>/gi, "_$1_")
      .replace(/<b>(.*?)<\/b>/gi, "**$1**")
      .replace(/<br\s*\/?>/gi, "\n")
      .trim();
    const textoPlano = cheerio
      .load(`<div>${conFormato}</div>`)("div")
      .text()
      .trim();

    if (textoPlano) current.texto.push(textoPlano);
  }

  return readings;
}

/**
 * Obtiene y parsea las lecturas del día indicado (por defecto, hoy).
 * @param {Date} date
 * @returns {Promise<object>}
 */
export async function getVaticanReadings(date = new Date()) {
  const { url, yyyy, mm, dd } = buildSpeechUrl(date);

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

  const data = await res.json();
  const item = data?.speech?.[0];

  if (!item) {
    throw new Error("Respuesta inesperada: no se encontró data.speech[0]");
  }

  const $ = cheerio.load("<div></div>");

  const lecturas = parseReadingsHtml(
    $,
    item.letturaText || "",
    /^(Primera|Segunda) lectura$/i,
  );
  const [primeraLectura = null, segundaLectura = null] = lecturas;

  const evangelioArr = parseReadingsHtml($, item.vangeloText || "", null);
  const evangelio = evangelioArr[0] || null;

  const $reflexion = cheerio.load(`<div>${item.hfwText || ""}</div>`);
  const reflexionPapal = $reflexion("div").text().trim() || null;

  return {
    fecha: `${yyyy}-${mm}-${dd}`,
    url,
    primeraLectura,
    salmo: null, // No publicado por Vatican News en ningún endpoint conocido
    segundaLectura,
    evangelio,
    reflexionPapal,
  };
}
