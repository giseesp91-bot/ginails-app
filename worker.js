export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Content-Security-Policy',
      "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://*.firebaseapp.com https://*.firebase.com https://*.googleusercontent.com; connect-src * https://script.google.com; frame-src *;"
    );
    newHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  }
};
