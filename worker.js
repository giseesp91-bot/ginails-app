export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
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
