// Simple proxy to bypass CORS/blocking for streaming
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || 'https://aniwatchtv.to';

    if (!targetUrl) {
      return new Response('URL parameter required', { status: 400 });
    }

    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
          'Referer': referer,
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': referer,
        }
      });

      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Referer, Origin');

      return new Response(response.body, {
        status: response.status,
        headers: headers
      });
    } catch (e) {
      return new Response('Upstream error: ' + e.message, { status: 500 });
    }
  }
};