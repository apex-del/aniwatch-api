const express = require('express');
const axios = require("axios");
const crypto = require("crypto");

const src1 = express();

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";
const MEGACLOUD_KEY_URL = "https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt";

let cachedKey = null;
let keyLastFetched = 0;
const KEY_CACHE_DURATION = 3600000; // 1 hour

async function getDecryptionKey() {
  const now = Date.now();
  if (cachedKey && (now - keyLastFetched) < KEY_CACHE_DURATION) {
    return cachedKey;
  }
  try {
    const { data } = await axios.get(MEGACLOUD_KEY_URL, { timeout: 5000 });
    cachedKey = data.trim();
    keyLastFetched = now;
    return cachedKey;
  } catch (e) {
    console.log('Failed to fetch key:', e.message);
    return cachedKey || 'c05d6f8a9b2e4d1f3a7c8e9b0d1f2a3c';
  }
}

async function extractToken(url) {
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 10000
    });
    const match = data.match(/eval\(function\(.*?\}\s*\(.*?\)\)\)/);
    if (!match) return null;
    const script = match[0];
    const varMatch = script.match(/window\["(.*?)"\]/);
    if (varMatch) {
      const key = varMatch[1];
      const keyValueMatch = script.match(new RegExp(`${key}\\s*=\\s*["']([^"']+)["']`));
      return keyValueMatch ? keyValueMatch[1] : null;
    }
    return null;
  } catch (e) {
    console.log('Token extract error:', e.message);
    return null;
  }
}

function decryptSources(encrypted, key) {
  try {
    if (typeof encrypted !== 'string') {
      return encrypted;
    }
    const decrypted = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.slice(0, 32), 'utf8'), Buffer.from(key.slice(32, 48), 'utf8'));
    let result = decrypted.update(encrypted, 'base64', 'utf8');
    result += decrypted.final('utf8');
    return JSON.parse(result);
  } catch (e) {
    console.log('Decrypt error:', e.message);
    return null;
  }
}

src1.get('/src-server/:id', async (req, res) => {
  try {
    const srcId = req.params.id;
    console.log('Getting stream for srcId:', srcId);
    
    // Try direct megacloud source (if available)
    const sourcesUrl = `https://megacloud.tv/embed-2/ajax/e-1/getSources?id=${srcId}`;
    
    const { data } = await axios.get(sourcesUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://megacloud.tv/'
      },
      timeout: 15000
    });
    
    if (!data.sources) {
      return res.status(404).json({ error: 'No sources found' });
    }
    
    let sources = data.sources;
    if (typeof sources === 'string' && data.encrypted) {
      const key = await getDecryptionKey();
      sources = decryptSources(sources, key);
    }
    
    const result = {
      sources: sources.map(s => ({ file: s.file, type: s.type })),
      tracks: data.tracks || [],
      intro: data.intro || { start: 0, end: 0 },
      outro: data.outro || { start: 0, end: 0 }
    };
    
    res.json({ serverSrc: [{ rest: result.sources }] });
  } catch (error) {
    console.error('Stream error:', error.message);
    res.status(500).json({ error: 'Failed to get stream: ' + error.message });
  }
});

module.exports = src1;
