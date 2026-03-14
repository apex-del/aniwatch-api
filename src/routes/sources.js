const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const sources = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

sources.use(cors());

const BASE_URLS = [
    'https://aniwatchtv.to',
    'https://aniwatch.to',
];

const MEGACLOUD_BASE = 'https://megacloud.tv';
const PROXY_URL = 'https://hianime-api-proxy.anonymous-0709200.workers.dev';
const KEY_URL = 'https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt';

let cachedKey = null;
let keyLastFetched = 0;
const KEY_CACHE_DURATION = 3600000;

async function fetchWithFallback(urls, path, params = {}) {
    const errors = [];
    for (const baseUrl of urls) {
        try {
            const url = `${baseUrl}${path}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${baseUrl}/watch/`
                },
                timeout: 15000,
                ...params
            });
            return { data: response.data, baseUrl };
        } catch (e) {
            errors.push(`${baseUrl}: ${e.message}`);
            continue;
        }
    }
    throw new Error(`All sources failed: ${errors.join(', ')}`);
}

async function getDecryptionKey() {
    const now = Date.now();
    if (cachedKey && (now - keyLastFetched) < KEY_CACHE_DURATION) {
        return cachedKey;
    }
    try {
        const { data: key } = await axios.get(KEY_URL, { timeout: 5000 });
        cachedKey = key.trim();
        keyLastFetched = now;
        return cachedKey;
    } catch (error) {
        if (cachedKey) return cachedKey;
        // Use a common key as fallback
        return 'bQ!s8H@k#p2$Ln5m9';
    }
}

// Simple flow: embed URL -> extract ID -> call API -> decrypt -> m3u8
async function getStreamUrl(embedLink) {
    try {
        const isMegacloud = embedLink.includes('megacloud');
        
        // Fetch embed page with proper headers to get token
        const pageRes = await axios.get(embedLink, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': MEGACLOUD_BASE + '/',
                'Accept': 'text/html',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout: 15000
        });
        
        const html = pageRes.data;
        
        // Check if embed is dead
        if (html.includes('File not found') || html.includes('not-found')) {
            return { error: 'Embed not available', m3u8: null };
        }
        
        // Find video ID and token
        let videoId = null;
        let token = null;
        
        // Get token from meta tag
        const tokenMatch = html.match(/name="_gg_fb"\s+content="([^"]+)"/);
        if (tokenMatch) token = tokenMatch[1];
        
        // Get ID from data-id attribute
        const idMatch1 = html.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
        if (idMatch1) videoId = idMatch1[1];
        
        // Fallback: extract from embed URL
        if (!videoId) {
            const idMatch2 = embedLink.match(/\/e-1\/([a-zA-Z0-9_-]+)/);
            if (idMatch2) videoId = idMatch2[1];
        }
        
        if (!videoId) {
            return { error: 'Video ID not found', m3u8: null };
        }
        
        console.log('Found video ID:', videoId, 'Token:', token ? 'yes' : 'no');
        
        // Build API URL with token
        let apiUrl = `https://megacloud.tv/ajax/embed/getSources?id=${videoId}`;
        if (token) {
            apiUrl += `&_k=${token}`;
        }
        
        console.log('Calling megacloud API...');
        
        // Try direct API call first (works from server)
        try {
            const apiRes = await axios.get(apiUrl, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': embedLink,
                    'Accept': 'application/json'
                },
                timeout: 15000
            });
            
            const apiData = apiRes.data;
            
            if (!apiData.sources) {
                return { error: 'No sources in API response', m3u8: null };
            }
            
            // Check if sources are encrypted
            if (typeof apiData.sources === 'string' && apiData.sources.startsWith('U2FsdGVkX')) {
                console.log('Sources are encrypted, decrypting...');
                
                const key = await getDecryptionKey();
                
                try {
                    let decrypted = CryptoJS.AES.decrypt(apiData.sources, key).toString(CryptoJS.enc.Utf8);
                    if (!decrypted) {
                        decrypted = CryptoJS.AES.decrypt(apiData.sources, CryptoJS.enc.Hex.parse(key)).toString(CryptoJS.enc.Utf8);
                    }
                    
                    if (decrypted) {
                        const sources = JSON.parse(decrypted);
                        return {
                            m3u8: sources[0]?.file || null,
                            tracks: apiData.tracks || [],
                            intro: apiData.intro || null,
                            outro: apiData.outro || null
                        };
                    }
                } catch (e) {
                    console.log('Decryption failed:', e.message);
                }
                
                return { error: 'Decryption failed', m3u8: null, encrypted: true };
            }
            
            return {
                m3u8: apiData.sources[0]?.file || null,
                tracks: apiData.tracks || [],
                intro: apiData.intro || null,
                outro: apiData.outro || null
            };
        } catch (apiError) {
            console.log('Direct API failed, trying proxy:', apiError.message);
            
            // Try via proxy
            const proxyUrl = `${PROXY_URL}/?url=${encodeURIComponent(apiUrl)}&referer=${encodeURIComponent(embedLink)}`;
            
            const proxyRes = await axios.get(proxyUrl, { timeout: 15000 });
            const apiData = proxyRes.data;
            
            if (!apiData.sources) {
                return { error: 'No sources from proxy', m3u8: null };
            }
            
            if (typeof apiData.sources === 'string' && apiData.sources.startsWith('U2FsdGVkX')) {
                const key = await getDecryptionKey();
                try {
                    let decrypted = CryptoJS.AES.decrypt(apiData.sources, key).toString(CryptoJS.enc.Utf8);
                    if (decrypted) {
                        const sources = JSON.parse(decrypted);
                        return { m3u8: sources[0]?.file || null, tracks: apiData.tracks || [] };
                    }
                } catch (e) {}
                return { error: 'Proxy decryption failed', m3u8: null };
            }
            
            return { m3u8: apiData.sources[0]?.file || null, tracks: apiData.tracks || [] };
        }
        
    } catch (error) {
        console.log('Stream extraction error:', error.message);
        return { error: error.message, m3u8: null };
    }
}
        
        // Find video ID - multiple patterns
        let videoId = null;
        
        // Pattern 1: id: 'xxx' or id: "xxx"
        const idMatch1 = html.match(/id:\s*['"]([a-zA-Z0-9_-]+)['"]/);
        if (idMatch1) videoId = idMatch1[1];
        
        // Pattern 2: data-id="xxx"
        if (!videoId) {
            const idMatch2 = html.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
            if (idMatch2) videoId = idMatch2[1];
        }
        
        // Pattern 3: embed-6/e-1/xxx
        if (!videoId) {
            const idMatch3 = embedLink.match(/\/e-1\/([a-zA-Z0-9_-]+)/);
            if (idMatch3) videoId = idMatch3[1];
        }
        
        if (!videoId) {
            return { error: 'Video ID not found in embed page', m3u8: null };
        }
        
        console.log('Found video ID:', videoId);
        
        // Call megacloud AJAX API
        const apiUrl = `https://megacloud.tv/ajax/embed/getSources?id=${videoId}`;
        const apiFetchUrl = isMegacloud
            ? `${PROXY_URL}/?url=${encodeURIComponent(apiUrl)}&referer=${encodeURIComponent(embedLink)}`
            : apiUrl;
        
        const apiRes = await axios.get(apiFetchUrl, {
            headers: isMegacloud ? {} : {
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': embedLink
            },
            timeout: 15000
        });
        
        const apiData = apiRes.data;
        
        if (!apiData.sources) {
            return { error: 'No sources in API response', m3u8: null };
        }
        
        // Check if sources are encrypted
        if (typeof apiData.sources === 'string' && apiData.sources.startsWith('U2FsdGVkX')) {
            console.log('Sources are encrypted, attempting to decrypt...');
            
            const key = await getDecryptionKey();
            
            try {
                let decrypted = CryptoJS.AES.decrypt(apiData.sources, key).toString(CryptoJS.enc.Utf8);
                if (!decrypted) {
                    decrypted = CryptoJS.AES.decrypt(apiData.sources, CryptoJS.enc.Hex.parse(key)).toString(CryptoJS.enc.Utf8);
                }
                
                if (decrypted) {
                    const sources = JSON.parse(decrypted);
                    return {
                        m3u8: sources[0]?.file || null,
                        tracks: apiData.tracks || [],
                        intro: apiData.intro || null,
                        outro: apiData.outro || null
                    };
                }
            } catch (e) {
                console.log('Decryption failed:', e.message);
            }
            
            return { error: 'Failed to decrypt sources', m3u8: null, encrypted: true };
        }
        
        // Return unencrypted sources
        return {
            m3u8: apiData.sources[0]?.file || null,
            tracks: apiData.tracks || [],
            intro: apiData.intro || null,
            outro: apiData.outro || null
        };
        
    } catch (error) {
        console.log('Stream extraction error:', error.message);
        return { error: error.message, m3u8: null };
    }
}

sources.get('/', async (req, res) => {
    const { id, server, category } = req.query;
    
    if (!id) {
        return res.status(400).json({ error: 'Episode ID required' });
    }
    
    console.log('Getting sources for:', id, 'server:', server, 'category:', category);
    
    try {
        const episodeMatch = id.match(/ep=(\d+)/);
        const episodeId = episodeMatch ? episodeMatch[1] : id.match(/\d+/)?.[0];
        
        if (!episodeId) {
            return res.status(400).json({ error: 'Invalid episode ID format' });
        }
        
        const serversUrl = `/ajax/v2/episode/servers?episodeId=${episodeId}`;
        const { data: serverData } = await fetchWithFallback(BASE_URLS, serversUrl);
        
        const $ = cheerio.load(serverData.html || '');
        
        const subServers = [];
        const dubServers = [];
        
        $('.servers-sub .server-item').each(function() {
            subServers.push({
                id: $(this).attr('data-id'),
                name: $(this).find('a').text().trim().toLowerCase()
            });
        });
        
        $('.servers-dub .server-item').each(function() {
            dubServers.push({
                id: $(this).attr('data-id'),
                name: $(this).find('a').text().trim().toLowerCase()
            });
        });
        
        const targetServers = (category === 'dub') ? dubServers : subServers;
        
        let selectedServer = null;
        const serverName = (server || 'hd-1').toLowerCase();
        
        if (serverName === 'hd-1' || serverName === 'vidsrc') {
            selectedServer = targetServers.find(s => s.name.includes('vidsrc')) || targetServers[0];
        } else if (serverName === 'hd-2' || serverName === 'megacloud') {
            selectedServer = targetServers.find(s => s.name.includes('mega')) || targetServers[0];
        } else {
            selectedServer = targetServers[0];
        }
        
        if (!selectedServer) {
            return res.status(404).json({ error: 'No servers available for this type' });
        }
        
        console.log('Using server:', selectedServer);
        
        // Get embed link
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const { data: sourceData } = await fetchWithFallback(BASE_URLS, sourceUrl);
        
        let embedLink = sourceData.link;
        
        // Get stream using simple flow
        let m3u8Url = null;
        let tracks = [];
        let intro = null;
        let outro = null;
        
        if (embedLink) {
            const streamResult = await getStreamUrl(embedLink);
            
            if (streamResult.m3u8) {
                m3u8Url = streamResult.m3u8;
                tracks = streamResult.tracks || [];
                intro = streamResult.intro;
                outro = streamResult.outro;
                console.log('Got m3u8:', m3u8Url.substring(0, 50) + '...');
            } else {
                console.log('Stream extraction failed:', streamResult.error);
                // Fallback to embed URL
                m3u8Url = embedLink;
            }
        }
        
        const isEmbedUrl = embedLink && m3u8Url === embedLink;
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: isEmbedUrl ? 'embed' : 'hls' }] : [],
                embed: embedLink,
                server: selectedServer.name,
                tracks: tracks,
                intro: intro,
                outro: outro,
                serverInfo: {
                    sub: subServers,
                    dub: dubServers,
                    selected: selectedServer
                }
            }
        });
        
    } catch (error) {
        console.error('Sources error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = sources;
