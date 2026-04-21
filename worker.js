// ⬇️ AGREGÁ ACÁ LOS EMAILS DE TUS BETA TESTERS
const OWNER_EMAIL = "gis.eesp91@gmail.com";

const BETA_EMAILS = [
  "gis.eesp91@gmail.com",
];

const MP_ACCESS_TOKEN = "APP_USR-206002900110129-040911-e9f1c65cad33e33720702c71a3f53cb5-125485692";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Verificar email beta
    if (url.pathname === '/api/verificar-email') {
      const email = url.searchParams.get('email') || '';
      const autorizada = BETA_EMAILS.map(e=>e.toLowerCase().trim()).includes(email.toLowerCase().trim());
      const esOwner = email.toLowerCase().trim() === OWNER_EMAIL.toLowerCase();
      return new Response(JSON.stringify({ autorizada, esOwner }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Crear preferencia de pago MercadoPago
    if (url.pathname === '/api/crear-pago' && request.method === 'POST') {
      const body = await request.json();
      const { plan, precio, descripcion, email, nombre } = body;

      const preference = {
        items: [{
          title:      descripcion,
          quantity:   1,
          unit_price: precio,
          currency_id: "ARS"
        }],
        payer: { email, name: nombre },
        back_urls: {
          success: `https://ginailspro-app.gis-eesp91.workers.dev/pago-exitoso.html`,
          failure: `https://ginailspro-app.gis-eesp91.workers.dev/pago.html`,
          pending: `https://ginailspro-app.gis-eesp91.workers.dev/pago.html`
        },
        auto_return: "approved",
        external_reference: `${email}|${plan}`
      };

      const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${MP_ACCESS_TOKEN}`
        },
        body: JSON.stringify(preference)
      });

      const mpData = await mpRes.json();
      return new Response(JSON.stringify({ init_point: mpData.init_point }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Archivos estáticos
    const response = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Security-Policy',
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com https://*.firebase.com https://sdk.mercadopago.com; connect-src *; frame-src *;"
    );
    return new Response(response.body, { status: response.status, headers: newHeaders });
  }
};
