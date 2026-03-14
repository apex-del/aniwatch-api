// Simple CORS proxy for megacloud - bypasses CORS restrictions
// Usage: https://your-worker.workers.dev/proxy?url=ENCODED_URL

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || 'https://aniwatchtv.to';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Referer, Origin, X-Requested-With',
        }
      });
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'url parameter required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    try {
      const response = await fetch(decodedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': referer,
          'Origin': referer,
          'X-Requested-With': 'XMLHttpRequest',
        }
      });

      const contentType = response.headers.get('content-type') || '';
      
      // If it's JSON, return as JSON
      if (contentType.includes('application/json')) {
        const data = await response.json();
        
        // If it contains sources, return them directly
        if (data.sources) {
          // Check if sources need decryption
          if (typeof data.sources === 'string' && data.sources.startsWith('U2FsdGVkX')) {
            // Return encrypted sources for client-side decryption
            return new Response(JSON.stringify({
              encrypted: true,
              sources: data.sources,
              tracks: data.tracks || [],
              embed: decodedUrl
            }), {
              status: 200,
              headers: { 
                'Content-Type': 'application/json', 
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type'
              }
            });
          }
          
          return new Response(JSON.stringify({
            sources: data.sources,
            tracks: data.tracks || [],
            intro: data.intro,
            outro: data.outro
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // For HTML, proxy directly
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Referer, Origin');

      return new Response(response.body, {
        status: response.status,
        headers
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
