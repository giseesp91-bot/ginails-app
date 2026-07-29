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
 * SECRET a cargar en Cloudflare (Configuración → Variables → Secret):
 *   MP_ACCESS_TOKEN → Access Token de producción de MercadoPago
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
          "Access-Control-Allow-Headers": "Content-Type"
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
