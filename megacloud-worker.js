// Cloudflare Worker for m3u8 extraction from megacloud
// This extracts the decryption key from megacloud's JS files

const KEY_CACHE = { key: null, timestamp: 0 };
const CACHE_DURATION = 3600000; // 1 hour

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const embedUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('referer') || 'https://aniwatchtv.to';

    if (!embedUrl) {
      return new Response(JSON.stringify({ error: 'URL parameter required' }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    try {
      // Check cache first
      const now = Date.now();
      let decryptionKey = KEY_CACHE.key;
      
      if (!decryptionKey || (now - KEY_CACHE.timestamp) > CACHE_DURATION) {
        // Try to get key from embedded JS in the page
        const embedResponse = await fetch(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
            'Referer': referer,
          }
        });
        
        const html = await embedResponse.text();
        
        // Check if embed is available
        if (html.includes('File not found') || html.includes('not-found')) {
          return new Response(JSON.stringify({ 
            success: false,
            error: 'Embed not available',
            embed: embedUrl
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Try to extract key from window variables in the page
        const windowKeyMatch = html.match(/window\.(\w+)\s*=\s*["']([a-zA-Z0-9_-]{20,})["']/);
        
        if (windowKeyMatch) {
          decryptionKey = windowKeyMatch[2];
          KEY_CACHE.key = decryptionKey;
          KEY_CACHE.timestamp = now;
        } else {
          // Try to extract from meta tag
          const metaMatch = html.match(/name="_gg_fb"\s+content="([^"]+)"/);
          if (metaMatch) {
            decryptionKey = metaMatch[1];
            KEY_CACHE.key = decryptionKey;
            KEY_CACHE.timestamp = now;
          }
        }
      }

      if (!decryptionKey) {
        return new Response(JSON.stringify({ 
          success: false,
          error: 'Could not extract decryption key',
          embed: embedUrl
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Extract embed ID from URL
      const embedIdMatch = embedUrl.match(/\/e-1\/([^?]+)/);
      const embedId = embedIdMatch ? embedIdMatch[1] : null;

      if (!embedId) {
        return new Response(JSON.stringify({ 
          success: false,
          error: 'Could not extract embed ID',
          embed: embedUrl
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // Get domain from embed URL
      const embedDomain = embedUrl.match(/https?:\/\/[^/]+/)[0];

      // Fetch sources with key
      const sourcesUrl = `${embedDomain}/getSources?id=${embedId}&_k=${decryptionKey}`;
      
      const sourcesResponse = await fetch(sourcesUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': embedUrl,
        }
      });

      const sourcesData = await sourcesResponse.json();

      if (sourcesData.sources) {
        // Check if sources are encrypted
        if (typeof sourcesData.sources === 'string') {
          // Need to decrypt - but we need CryptoJS which isn't available in worker
          // Return the encrypted data for client-side decryption
          return new Response(JSON.stringify({
            success: true,
            encrypted: true,
            encryptedData: sourcesData.sources,
            key: decryptionKey,
            embed: embedUrl,
            message: 'Encrypted - client needs to decrypt'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } else {
          // Sources are not encrypted, return directly
          return new Response(JSON.stringify({
            success: true,
            sources: sourcesData.sources,
            tracks: sourcesData.tracks || [],
            intro: sourcesData.intro || null,
            outro: sourcesData.outro || null,
            embed: embedUrl
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      return new Response(JSON.stringify({ 
        success: false,
        error: 'No sources found',
        embed: embedUrl
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });

    } catch (e) {
      return new Response(JSON.stringify({ 
        success: false,
        error: e.message 
      }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
