// Cloudflare Worker - Megacloud bypass proxy
// Deploy this to bypass megacloud blocking

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || 'https://aniwatchtv.to';

    if (!targetUrl) {
      return new Response('url parameter required', { status: 400 });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    try {
      const response = await fetch(decodedUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': referer,
          'Origin': referer,
          'X-Requested-With': 'XMLHttpRequest',
        }
      });

      const contentType = response.headers.get('content-type') || '';
      
      // If JSON, return it
      if (contentType.includes('application/json')) {
        const data = await response.json();
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Referer, Origin, X-Requested-With'
          }
        });
      }

      // For HTML, return it
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Referer, Origin, X-Requested-With');

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
