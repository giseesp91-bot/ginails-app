/**
 * GINAILS PRO — Worker de la app (ginailspro-app)
 * -------------------------------------------------
 * Sirve los archivos estáticos y arma el cobro en MercadoPago.
 *
 * ── FUNDADORAS ────────────────────────────────────
 * Antes de crear la suscripción le pregunta al worker del webhook
 * si quedan lugares. Si hay cupo, cobra el precio con 15% menos y
 * marca el external_reference con "|fund", para que el webhook sepa
 * que ese cobro se hizo con precio de fundadora.
 * Si algo falla al consultar, cobra SIEMPRE precio de lista:
 * preferimos cobrar de más y arreglarlo a mano, antes que regalar
 * un descuento de por vida por error.
 *
 * SECRETS a cargar en Cloudflare (Configuración → Variables y secretos):
 *   MP_ACCESS_TOKEN → Access Token de producción de MercadoPago
 *   ADMIN_SECRET    → la MISMA clave que tenés en el worker del webhook.
 *                     Se usa solo de servidor a servidor, nunca llega al navegador.
 *
 * VARIABLE normal (opcional):
 *   WEBHOOK_URL → https://ginails-mp-webhook.gis-eesp91.workers.dev
 */

const OWNER_EMAIL = "gis.eesp91@gmail.com";

// El token de MercadoPago vive como Secret en Cloudflare (MP_ACCESS_TOKEN).
// Acá queda vacío a propósito: nunca hay que escribirlo en el código,
// porque este archivo está en GitHub y quedaría a la vista de cualquiera.
const MP_TOKEN_VIEJO = "";

const WEBHOOK_URL_DEFAULT = "https://ginails-mp-webhook.gis-eesp91.workers.dev";

const FUND_DESCUENTO = 15; // %

// Niveles válidos, de menor a mayor
const NIVELES = ["esencial", "pro", "elite"];

const NOMBRES = { esencial: "Esencial", pro: "Pro", elite: "Elite" };

// Precios de lista (deben coincidir con worker-mp-webhook.js y pago.html)
const PRECIOS_LISTA = {
  esencial: { mensual: 29900, anual: 299000 },
  pro:      { mensual: 39900, anual: 380000 },
  elite:    { mensual: 54900, anual: 520000 }
};

function precioLista(nivel, periodo) {
  const n = PRECIOS_LISTA[nivel];
  if (!n) return null;
  return n[periodo === "anual" ? "anual" : "mensual"];
}

function conDescuento(monto) {
  return Math.round((monto * (100 - FUND_DESCUENTO)) / 100);
}

function grillaPrecios(aplicarDescuento) {
  const out = {};
  for (const n of NIVELES) {
    out[n] = {
      mensual: aplicarDescuento ? conDescuento(PRECIOS_LISTA[n].mensual) : PRECIOS_LISTA[n].mensual,
      anual: aplicarDescuento ? conDescuento(PRECIOS_LISTA[n].anual) : PRECIOS_LISTA[n].anual
    };
  }
  return out;
}

/**
 * Arma la suscripción de MercadoPago para un nivel y período dados.
 * El período define la frecuencia del cobro recurrente.
 */
function armarPlan(nivel, periodo, monto) {
  const anual = periodo === "anual";
  return {
    reason: `Ginails Pro · Plan ${NOMBRES[nivel]} ${anual ? "Anual" : "Mensual"}`,
    auto_recurring: {
      frequency: anual ? 12 : 1,
      frequency_type: "months",
      transaction_amount: monto,
      currency_id: "ARS"
    }
  };
}

function tokenMP(env) {
  return env.MP_ACCESS_TOKEN || MP_TOKEN_VIEJO;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

const FIREBASE_PROJECT_ID = "ginails-cosmetologia";

/* ==========================================================
   VERIFICACIÓN DEL TOKEN DE FIREBASE
   ----------------------------------------------------------
   Sin esto, cualquiera podría cambiarle el plan a otra persona
   mandando su email. Acá comprobamos de verdad la FIRMA del token
   contra las claves públicas de Google. No alcanza con leer el
   contenido del token: eso lo falsifica cualquiera.
   ========================================================== */
let certsCache = { certs: null, exp: 0 };

async function certificadosDeGoogle() {
  const ahora = Date.now();
  if (certsCache.certs && certsCache.exp > ahora) return certsCache.certs;
  const res = await fetch(
    "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com"
  );
  if (!res.ok) throw new Error("No pude traer las claves de Google");
  const certs = await res.json();
  // Respetamos el max-age que manda Google
  const cc = res.headers.get("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  certsCache = { certs, exp: ahora + (m ? Number(m[1]) : 3600) * 1000 };
  return certs;
}

function b64urlABytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemADer(pem) {
  const limpio = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s/g, "");
  const bin = atob(limpio);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Saca la clave pública RSA de dentro de un certificado X.509 (formato DER). */
function clavePublicaDelCertificado(der) {
  // Recorremos la estructura ASN.1 hasta el SubjectPublicKeyInfo.
  let i = 0;
  const leerLargo = () => {
    let largo = der[i++];
    if (largo & 0x80) {
      const n = largo & 0x7f;
      largo = 0;
      for (let k = 0; k < n; k++) largo = (largo << 8) | der[i++];
    }
    return largo;
  };
  const entrar = () => { i++; leerLargo(); };          // entrar en una secuencia
  const saltar = () => { i++; const l = leerLargo(); i += l; };

  entrar();          // Certificate
  entrar();          // tbsCertificate
  if (der[i] === 0xa0) saltar();                        // version
  saltar();          // serialNumber
  saltar();          // signature
  saltar();          // issuer
  saltar();          // validity
  saltar();          // subject
  const ini = i;     // acá arranca subjectPublicKeyInfo
  saltar();
  return der.slice(ini, i);
}

/**
 * Devuelve el email verificado del token, o null si el token no sirve.
 */
async function emailDelToken(request) {
  try {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;

    const partes = token.split(".");
    if (partes.length !== 3) return null;

    const header = JSON.parse(new TextDecoder().decode(b64urlABytes(partes[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlABytes(partes[1])));

    if (header.alg !== "RS256" || !header.kid) return null;

    // Comprobaciones del contenido
    const ahora = Math.floor(Date.now() / 1000);
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
    if (!payload.exp || payload.exp < ahora) return null;
    if (payload.iat && payload.iat > ahora + 300) return null;
    if (!payload.email) return null;

    // Comprobación de la firma
    const certs = await certificadosDeGoogle();
    const pem = certs[header.kid];
    if (!pem) return null;

    const clave = await crypto.subtle.importKey(
      "spki",
      clavePublicaDelCertificado(pemADer(pem)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const firmaOk = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      clave,
      b64urlABytes(partes[2]),
      new TextEncoder().encode(partes[0] + "." + partes[1])
    );
    if (!firmaOk) return null;

    return String(payload.email).trim();
  } catch (e) {
    console.log("Token inválido:", e.message);
    return null;
  }
}

/** Llama al worker del webhook, que es el que tiene acceso a Firestore. */
async function llamarWebhook(env, ruta, opciones = {}) {
  const base = env.WEBHOOK_URL || WEBHOOK_URL_DEFAULT;
  const res = await fetch(`${base}${ruta}`, {
    method: opciones.method || "GET",
    headers: {
      "X-Admin-Secret": env.ADMIN_SECRET || "",
      ...(opciones.body ? { "Content-Type": "application/json" } : {})
    },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined
  });
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

/**
 * Le pregunta al webhook si esta usuaria tiene derecho al precio de fundadora.
 * Ante CUALQUIER problema devuelve elegible:false → precio de lista.
 */
async function consultarFundadora(env, email) {
  const base = env.WEBHOOK_URL || WEBHOOK_URL_DEFAULT;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${base}/fundadoras?email=${encodeURIComponent(email || "")}`, {
      signal: ctrl.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return { elegible: false, motivo: "consulta fallida" };
    const d = await res.json();
    return {
      elegible: !!d.elegible,
      yaEsFundadora: !!d.yaEsFundadora,
      motivo: d.motivo || "",
      descuentoPct: d.descuentoPct || FUND_DESCUENTO
    };
  } catch (e) {
    console.log("No pude consultar el cupo de fundadoras:", e.message);
    return { elegible: false, motivo: "sin respuesta del webhook" };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    // Verificar acceso - cualquiera puede entrar, owner tiene acceso ilimitado
    if (url.pathname === "/api/verificar-email") {
      const email = url.searchParams.get("email") || "";
      const esOwner = email.toLowerCase().trim() === OWNER_EMAIL.toLowerCase();
      return new Response(JSON.stringify({ autorizada: true, esOwner }), { headers: JSON_HEADERS });
    }

    // Precios que le corresponden a esta usuaria (lo usa pago.html)
    if (url.pathname === "/api/precios") {
      const email = url.searchParams.get("email") || "";
      const f = await consultarFundadora(env, email);
      return new Response(
        JSON.stringify({
          niveles: NIVELES,
          nombres: NOMBRES,
          precios: grillaPrecios(f.elegible),
          lista: PRECIOS_LISTA,
          conDescuento: f.elegible,
          descuentoPct: f.elegible ? FUND_DESCUENTO : 0
        }),
        { headers: JSON_HEADERS }
      );
    }

    /* ---------- MI PLAN (requiere estar logueada) ---------- */
    if (url.pathname === "/api/mi-plan") {
      const email = await emailDelToken(request);
      if (!email) return new Response(JSON.stringify({ error: "no-autenticada" }), { status: 401, headers: JSON_HEADERS });

      const r = await llamarWebhook(env, `/plan-estado?email=${encodeURIComponent(email)}`);
      if (!r.ok) return new Response(JSON.stringify({ error: "sin-datos" }), { status: 502, headers: JSON_HEADERS });
      return new Response(JSON.stringify({ ...r.data, email, esOwner: email.toLowerCase() === OWNER_EMAIL.toLowerCase() }), { headers: JSON_HEADERS });
    }

    /* ---------- CAMBIAR DE PLAN (requiere estar logueada) ---------- */
    if (url.pathname === "/api/cambiar-plan" && request.method === "POST") {
      const email = await emailDelToken(request);
      if (!email) return new Response(JSON.stringify({ error: "no-autenticada" }), { status: 401, headers: JSON_HEADERS });

      let body = {};
      try { body = await request.json(); } catch (_) {}
      const nivel = String(body.nivel || "").toLowerCase();
      if (!NIVELES.includes(nivel))
        return new Response(JSON.stringify({ error: "Plan no válido" }), { status: 400, headers: JSON_HEADERS });

      // OJO: el email sale del token verificado, NUNCA de lo que manda el navegador.
      const r = await llamarWebhook(env, "/cambiar-plan", { method: "POST", body: { email, nivel } });
      return new Response(JSON.stringify(r.data), { status: r.ok ? 200 : 502, headers: JSON_HEADERS });
    }

    /* ---------- DAR DE BAJA UN CAMBIO PENDIENTE ---------- */
    if (url.pathname === "/api/cancelar-cambio" && request.method === "POST") {
      const email = await emailDelToken(request);
      if (!email) return new Response(JSON.stringify({ error: "no-autenticada" }), { status: 401, headers: JSON_HEADERS });
      const r = await llamarWebhook(env, "/cancelar-cambio", { method: "POST", body: { email } });
      return new Response(JSON.stringify(r.data), { status: r.ok ? 200 : 502, headers: JSON_HEADERS });
    }

    // Crear suscripción MercadoPago
    if (url.pathname === "/api/crear-pago" && request.method === "POST") {
      const body = await request.json();
      const { email, nombre } = body;

      // `nivel` es esencial/pro/elite y `periodo` mensual/anual.
      // Se acepta también el formato viejo donde `plan` traía el período.
      const nivel = String(body.nivel || body.plan || "").toLowerCase();
      const periodo = String(body.periodo || "mensual").toLowerCase();

      if (!NIVELES.includes(nivel)) {
        return new Response(
          JSON.stringify({ error: "Plan no válido. Usá: " + NIVELES.join(", ") }),
          { status: 400, headers: JSON_HEADERS }
        );
      }
      if (periodo !== "mensual" && periodo !== "anual") {
        return new Response(JSON.stringify({ error: "Período no válido" }), {
          status: 400,
          headers: JSON_HEADERS
        });
      }

      // ¿Le corresponde el precio de fundadora?
      const f = await consultarFundadora(env, email);
      const montoLista = precioLista(nivel, periodo);
      const monto = f.elegible ? conDescuento(montoLista) : montoLista;

      const planConfig = armarPlan(nivel, periodo, monto);

      const suscripcion = {
        ...planConfig,
        reason: f.elegible ? `${planConfig.reason} · Fundadora` : planConfig.reason,
        payer_email: email,
        back_url: `https://ginailspro-app.gis-eesp91.workers.dev/pago-exitoso.html`,
        // Formato: email|nivel|periodo[|fund]
        // El "fund" le avisa al webhook que este cobro se hizo con precio de fundadora
        external_reference: f.elegible
          ? `${email}|${nivel}|${periodo}|fund`
          : `${email}|${nivel}|${periodo}`
      };

      console.log(
        `Cobro para ${email} · ${nivel} ${periodo} · $${monto}${f.elegible ? " (fundadora: " + f.motivo + ")" : ""}`
      );

      const mpRes = await fetch("https://api.mercadopago.com/preapproval_plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenMP(env)}`
        },
        body: JSON.stringify(suscripcion)
      });
      const mpData = await mpRes.json();

      if (mpData.init_point) {
        return new Response(
          JSON.stringify({
            init_point: mpData.init_point,
            nivel,
            periodo,
            monto,
            conDescuento: f.elegible,
            descuentoPct: f.elegible ? FUND_DESCUENTO : 0
          }),
          { headers: JSON_HEADERS }
        );
      } else {
        return new Response(JSON.stringify({ error: mpData }), {
          status: 500,
          headers: JSON_HEADERS
        });
      }
    }

    // Archivos estáticos
    const response = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(response.headers);
    newHeaders.set(
      "Content-Security-Policy",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com https://*.firebase.com; connect-src *; frame-src *;"
    );
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }
};
