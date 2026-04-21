export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy para Google Apps Script
    if (url.pathname === '/api/verificar-email') {
      const email = url.searchParams.get('email');
      const scriptUrl = `https://script.google.com/macros/s/AKfycbzCWb5QInEh90gHLKmqc0d_Bg3CWDY2Xet9BOUK7pDQ35xJJILnBVn3vtpyWCQwglCi/exec?email=${encodeURIComponent(email)}`;
      
      const resp = await fetch(scriptUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await resp.json();
      
      return new Response(JSON.stringify(data), {
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
