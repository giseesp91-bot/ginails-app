const OWNER_EMAIL = "gis.eesp91@gmail.com";

const MP_ACCESS_TOKEN = "APP_USR-206002900110129-040911-e9f1c65cad33e33720702c71a3f53cb5-125485692";

const PLANES = {
  mensual: {
    reason: "Ginails Pro · Plan Mensual",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 5000,
      currency_id: "ARS"
    }
  },
  anual: {
    reason: "Ginails Pro · Plan Anual",
    auto_recurring: {
      frequency: 12,
      frequency_type: "months",
      transaction_amount: 40000,
      currency_id: "ARS"
    }
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Verificar acceso - cualquiera puede entrar, owner tiene acceso ilimitado
    if (url.pathname === '/api/verificar-email') {
      const email = url.searchParams.get('email') || '';
      const esOwner = email.toLowerCase().trim() === OWNER_EMAIL.toLowerCase();
      return new Response(JSON.stringify({ autorizada: true, esOwner }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Crear suscripción MercadoPago
    if (url.pathname === '/api/crear-pago' && request.method === 'POST') {
      const body = await request.json();
      const { plan, email, nombre } = body;
      const planConfig = PLANES[plan];
      if (!planConfig) {
        return new Response(JSON.stringify({ error: 'Plan no válido' }), { status: 400 });
      }
      const suscripcion = {
        ...planConfig,
        payer_email: email,
        back_url: `https://ginailspro-app.gis-eesp91.workers.dev/pago-exitoso.html`,
        external_reference: `${email}|${plan}`
      };
      const mpRes = await fetch("https://api.mercadopago.com/preapproval_plan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
        },
        body: JSON.stringify(suscripcion)
      });
      const mpData = await mpRes.json();
      if (mpData.init_point) {
        return new Response(JSON.stringify({ init_point: mpData.init_point }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } else {
        return new Response(JSON.stringify({ error: mpData }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Archivos estáticos
    const response = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Security-Policy',
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com https://*.firebase.com; connect-src *; frame-src *;"
    );
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }
};
