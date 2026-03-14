// API compatibility layer - returns data in same format as old HiAnime API

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const compat = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

compat.use(cors());

const BASE_URLS = ['https://aniwatchtv.to', 'https://aniwatch.to'];
const MEGACLOUD_BASE = 'https://megacloud.tv';
const PROXY_URL = 'https://hianime-api-proxy.anonymous-0709200.workers.dev';
const KEY_URL = 'https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt';

let cachedKey = null;
let keyLastFetched = 0;
const KEY_CACHE_DURATION = 3600000;

async function fetchWithFallback(paths, params = {}) {
    for (const baseUrl of BASE_URLS) {
        try {
            const url = `${baseUrl}${paths[0]}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${baseUrl}/`
                },
                timeout: 15000,
                ...params
            });
            return { data: response.data, baseUrl };
        } catch (e) {
            continue;
        }
    }
    return null;
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
        return 'bQ!s8H@k#p2$Ln5m9';
    }
}

// Simple flow: embed -> extract ID -> call API -> decrypt -> m3u8
async function getStreamUrl(embedLink) {
    try {
        const isMegacloud = embedLink.includes('megacloud');
        const fetchUrl = isMegacloud 
            ? `${PROXY_URL}/?url=${encodeURIComponent(embedLink)}&referer=${encodeURIComponent(MEGACLOUD_BASE)}`
            : embedLink;
        
        const pageRes = await axios.get(fetchUrl, {
            headers: isMegacloud ? {} : {
                'User-Agent': USER_AGENT,
                'Referer': MEGACLOUD_BASE + '/'
            },
            timeout: 15000
        });
        
        const html = pageRes.data;
        
        if (html.includes('File not found') || html.includes('not-found')) {
            return { error: 'Embed not available', m3u8: null };
        }
        
        let videoId = null;
        
        // Try different patterns
        const idMatch1 = html.match(/id:\s*['"]([a-zA-Z0-9_-]+)['"]/);
        if (idMatch1) videoId = idMatch1[1];
        
        if (!videoId) {
            const idMatch2 = html.match(/data-id=["']([a-zA-Z0-9_-]+)["']/);
            if (idMatch2) videoId = idMatch2[1];
        }
        
        if (!videoId) {
            const idMatch3 = embedLink.match(/\/e-1\/([a-zA-Z0-9_-]+)/);
            if (idMatch3) videoId = idMatch3[1];
        }
        
        if (!videoId) {
            return { error: 'Video ID not found', m3u8: null };
        }
        
        console.log('Found video ID:', videoId);
        
        // Call megacloud API
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
        
        if (typeof apiData.sources === 'string' && apiData.sources.startsWith('U2FsdGVkX')) {
            console.log('Sources encrypted, decrypting...');
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
        
    } catch (error) {
        console.log('Stream error:', error.message);
        return { error: error.message, m3u8: null };
    }
}

// Get anime info - compatible format
compat.get('/anime/:id', async (req, res) => {
    const animeId = req.params.id;
    
    try {
        const url = `/${animeId}`;
        const response = await axios.get(`${BASE_URLS[0]}${url}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        const $ = cheerio.load(response.data);
        
        const info = {};
        const stats = {};
        
        info.name = $('.film-name.dynamic-name').text().trim() || animeId;
        
        const poster = $('.film-poster img').attr('src') || '';
        
        const epSub = $('.tick-sub').text().trim() || '0';
        const epDub = $('.tick-dub').text().trim() || '0';
        stats.episodes = { sub: epSub, dub: epDub, eps: epSub };
        
        info.type = $('.film-info .item:eq(0)').text().trim() || 'TV';
        const duration = $('.film-info .item:eq(1)').text().trim() || '24m';
        stats.duration = duration;
        stats.quality = $('.tick-quality').text().trim() || 'HD';
        stats.rating = $('.tick-pg').text().trim() || 'PG-13';
        
        info.description = $('.description .text').text().trim() || '';
        
        res.json({
            data: {
                anime: {
                    info: info,
                    stats: stats
                }
            }
        });
        
    } catch (e) {
        console.error('Anime info error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Get episodes list - compatible format  
compat.get('/anime/:id/episodes', async (req, res) => {
    const animeId = req.params.id;
    
    try {
        const epUrl = `https://aniwatch-api-zeta-dusky.vercel.app/api/episode/${animeId}`;
        const epRes = await axios.get(epUrl, { timeout: 15000 });
        
        const epData = epRes.data;
        const episodes = epData.episodetown || [];
        
        const formattedEpisodes = episodes.map((ep, i) => ({
            number: parseInt(ep.order) || i + 1,
            title: ep.name,
            episodeId: ep.epId.split('ep=')[1] || ''
        }));
        
        res.json({ data: { episodes: formattedEpisodes } });
        
    } catch (e) {
        console.error('Episodes error:', e.message);
        res.json({ data: { episodes: [] } });
    }
});

// Get episode sources - compatible format with simple flow
compat.get('/episode/sources', async (req, res) => {
    const { animeEpisodeId, server, category } = req.query;
    
    if (!animeEpisodeId) {
        return res.status(400).json({ error: 'animeEpisodeId required' });
    }
    
    try {
        const serversUrl = `/ajax/v2/episode/servers?episodeId=${animeEpisodeId}`;
        const serversRes = await fetchWithFallback([serversUrl]);
        
        if (!serversRes) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        const $ = cheerio.load(serversRes.data.html || '');
        
        const servers = [];
        const type = category || 'sub';
        
        $(`.servers-${type} .server-item`).each(function() {
            servers.push({
                id: $(this).attr('data-id'),
                name: $(this).find('a').text().trim().toLowerCase()
            });
        });
        
        let selectedServer = servers[0];
        if (server === 'hd-1') {
            selectedServer = servers.find(s => s.name.includes('vidsrc')) || servers[0];
        } else if (server === 'hd-2') {
            selectedServer = servers.find(s => s.name.includes('mega')) || servers[0];
        }
        
        if (!selectedServer) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const sourceRes = await fetchWithFallback([sourceUrl]);
        
        if (!sourceRes) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        let embedLink = sourceRes.data.link;
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
            } else {
                m3u8Url = embedLink;
            }
        }
        
        const isEmbedUrl = embedLink && m3u8Url === embedLink;
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: isEmbedUrl ? 'embed' : 'hls' }] : [],
                embed: embedLink,
                tracks: tracks,
                intro: intro,
                outro: outro,
                serverInfo: selectedServer
            }
        });
        
    } catch (e) {
        console.error('Sources error:', e.message);
        res.json({ data: { sources: [], tracks: [] } });
    }
});

// Stream endpoint
compat.get('/stream', async (req, res) => {
    const { id, server, type } = req.query;
    if (!id) {
        return res.status(400).json({ error: 'Episode ID required' });
    }
    
    const episodeMatch = id.match(/ep=(\d+)/);
    const episodeId = episodeMatch ? episodeMatch[1] : id.match(/\d+/)?.[0];
    
    if (!episodeId) {
        return res.status(400).json({ error: 'Invalid episode ID format' });
    }
    
    try {
        const serversUrl = `/ajax/v2/episode/servers?episodeId=${episodeId}`;
        const serversRes = await fetchWithFallback([serversUrl]);
        
        if (!serversRes) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        const $ = cheerio.load(serversRes.data.html || '');
        
        const targetType = type === 'dub' ? 'dub' : 'sub';
        const servers = [];
        
        $(`.servers-${targetType} .server-item`).each(function() {
            servers.push({
                id: $(this).attr('data-id'),
                name: $(this).find('a').text().trim().toLowerCase(),
                type: targetType
            });
        });
        
        let selectedServer = servers[0];
        if (server === 'hd-1') {
            selectedServer = servers.find(s => s.name.includes('vidsrc')) || servers[0];
        } else if (server === 'hd-2') {
            selectedServer = servers.find(s => s.name.includes('mega')) || servers[0];
        }
        
        if (!selectedServer) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const sourceRes = await fetchWithFallback([sourceUrl]);
        
        if (!sourceRes) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        let embedLink = sourceRes.data.link;
        let m3u8Url = null;
        let tracks = [];
        
        if (embedLink) {
            const streamResult = await getStreamUrl(embedLink);
            
            if (streamResult.m3u8) {
                m3u8Url = streamResult.m3u8;
                tracks = streamResult.tracks || [];
            } else {
                m3u8Url = embedLink;
            }
        }
        
        const isEmbedUrl = embedLink && m3u8Url === embedLink;
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: isEmbedUrl ? 'embed' : 'hls' }] : [],
                embed: embedLink,
                tracks: tracks,
                server: selectedServer.name
            }
        });
        
    } catch (e) {
        console.error('Stream error:', e.message);
        res.json({ data: { sources: [], tracks: [] } });
    }
});

module.exports = compat;
