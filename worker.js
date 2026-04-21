// ⬇️ AGREGÁ ACÁ LOS EMAILS DE TUS BETA TESTERS
const OWNER_EMAIL = "gis.eesp91@gmail.com";

const BETA_EMAILS = [
  "gis.eesp91@gmail.com",
  // otras beta testers acá
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Verificar email
    if (url.pathname === '/api/verificar-email') {
      const email = url.searchParams.get('email') || '';
      const autorizada = BETA_EMAILS
        .map(e => e.toLowerCase().trim())
        .includes(email.toLowerCase().trim());

      return new Response(JSON.stringify({ autorizada }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Archivos estáticos
    const response = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Security-Policy',
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com https://*.firebase.com; connect-src *; frame-src *;"
    );

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  }
};
