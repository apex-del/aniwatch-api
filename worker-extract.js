export default {
  async fetch(request) {
    const url = new URL(request.url);
    const embedUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || 'https://aniwatchtv.to';

    if (!embedUrl) {
      return new Response('URL parameter required', { status: 400 });
    }

    try {
      const response = await fetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
          'Referer': referer,
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': referer,
        }
      });

      const html = await response.text();
      
      // Check if embed is dead
      if (html.includes('File not found') || html.includes('not-found')) {
        return new Response(JSON.stringify({ 
          error: 'Embed not available', 
          sources: [],
          embed: embedUrl
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Try to extract m3u8 from the page
      // First check if there's a direct m3u8 in the response
      const m3u8Match = html.match(/sources?\s*:\s*\[([^\]]+)\]/);
      
      // Look for encrypted sources that need decryption
      const encryptedMatch = html.match(/sources\s*:\s*["']([^"']+)["']/);
      
      // Try to find the decryption key in the page
      const keyMatch = html.match(/window\.(\w+)\s*=\s*["']([a-zA-Z0-9_-]{20,})["']/);
      
      // Extract any m3u8 URL patterns
      const m3u8Patterns = html.match(/(https?:\/\/[^\s"'"']+\.m3u8[^\s"'"']*)/g);

      // Check for player config
      const playerConfigMatch = html.match(/player\.config\s*=\s*(\{[^}]+\})/);

      const result = {
        embed: embedUrl,
        htmlLength: html.length,
        hasEncrypted: !!encryptedMatch,
        keyFound: !!keyMatch,
        m3u8Patterns: m3u8Patterns ? m3u8Patterns.slice(0, 3) : [],
        playerConfig: playerConfigMatch ? 'found' : 'not found',
        message: 'Check html content for more extraction options'
      };

      // If we found m3u8 patterns, try the first one
      if (m3u8Patterns && m3u8Patterns.length > 0) {
        // Try to fetch the m3u8 directly
        try {
          const m3u8Response = await fetch(m3u8Patterns[0], {
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Referer': embedUrl
            }
          });
          if (m3u8Response.ok) {
            const m3u8Content = await m3u8Response.text();
            result.m3u8Content = m3u8Content.substring(0, 500);
            result.m3u8Url = m3u8Patterns[0];
          }
        } catch (e) {
          result.m3u8Error = e.message;
        }
      }

      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Referer, Origin');

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
