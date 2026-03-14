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
const KEY_URL = 'https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt';
const KEY_ALT_URL = 'https://gist.githubusercontent.com/eggwite/main/raw/key.txt';

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
        console.log('Primary key failed, trying alternative...');
        try {
            const { data: key } = await axios.get(KEY_ALT_URL, { timeout: 5000 });
            cachedKey = key.trim();
            keyLastFetched = now;
            return cachedKey;
        } catch (error2) {
            if (cachedKey) return cachedKey;
            throw new Error('Unable to fetch decryption key');
        }
    }
}

async function extractToken(url) {
    try {
        const { data: html } = await axios.get(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': MEGACLOUD_BASE + '/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            },
            timeout: 10000
        });

        const $ = cheerio.load(html);

        const meta = $('meta[name="_gg_fb"]').attr('content');
        if (meta && meta.length >= 10) return meta;

        const dpi = $('[data-dpi]').attr('data-dpi');
        if (dpi && dpi.length >= 10) return dpi;

        const nonceScript = $('script[nonce]')
            .filter((i, el) => $(el).text().includes('nonce'))
            .attr('nonce');
        if (nonceScript && nonceScript.length >= 10) return nonceScript;

        const stringAssignRegex = /window\.(\w+)\s*=\s*["']([a-zA-Z0-9_-]{10,})["']/g;
        const stringMatches = [...html.matchAll(stringAssignRegex)];
        for (const [, key, value] of stringMatches) {
            if (value.length >= 10) return value;
        }

        throw new Error('No token found');
    } catch (error) {
        return null;
    }
}

async function decryptSources(embedLink, key) {
    try {
        const embedDomain = embedLink.match(/https?:\/\/[^/]+/)?.[0] || MEGACLOUD_BASE;
        const embedId = embedLink.split('/e-1/')[1]?.split('?')[0] || embedLink.split('/e-2/')[1]?.split('?')[0];
        
        if (!embedId) {
            throw new Error('Could not extract embed ID');
        }

        const tokenUrl = `${embedDomain}/${embedId}?k=1&autoPlay=0&oa=0&asi=1`;
        const token = await extractToken(tokenUrl);
        
        if (!token) {
            throw new Error('Failed to extract token');
        }

        const { data } = await axios.get(
            `${embedDomain}/getSources?id=${embedId}&_k=${token}`,
            {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${embedDomain}/${embedId}`,
                },
                timeout: 15000
            }
        );

        const encrypted = data?.sources;
        if (!encrypted) {
            throw new Error('No encrypted sources found');
        }

        let sources = null;
        if (typeof encrypted === 'string') {
            let decrypted = CryptoJS.AES.decrypt(encrypted, key).toString(CryptoJS.enc.Utf8);
            if (!decrypted) {
                decrypted = CryptoJS.AES.decrypt(encrypted, CryptoJS.enc.Hex.parse(key)).toString(CryptoJS.enc.Utf8);
            }
            if (!decrypted) {
                throw new Error('Decryption failed');
            }
            sources = JSON.parse(decrypted);
        } else {
            sources = encrypted;
        }

        return {
            sources: sources,
            tracks: data.tracks || [],
            intro: data.intro || null,
            outro: data.outro || null
        };
    } catch (error) {
        console.log('Decryption error:', error.message);
        return null;
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

// Get episode sources - compatible format with decryption
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
            try {
                const key = await getDecryptionKey();
                const decrypted = await decryptSources(embedLink, key);
                
                if (decrypted && decrypted.sources && decrypted.sources[0]?.file) {
                    m3u8Url = decrypted.sources[0].file;
                    tracks = decrypted.tracks || [];
                    intro = decrypted.intro;
                    outro = decrypted.outro;
                    console.log('Successfully decrypted m3u8!');
                } else {
                    console.log('Trying direct m3u8 fetch...');
                    const embedDomain = embedLink.match(/https?:\/\/[^/]+/)?.[0] || MEGACLOUD_BASE;
                    const embedId = embedLink.split('/e-1/')[1]?.split('?')[0];
                    if (embedId) {
                        const directUrl = `${embedDomain}/getSources?id=${embedId}`;
                        const m3u8Res = await axios.get(directUrl, {
                            headers: {
                                'User-Agent': USER_AGENT,
                                'X-Requested-With': 'XMLHttpRequest',
                                'Referer': embedLink
                            },
                            timeout: 15000
                        });
                        if (m3u8Res.data?.sources) {
                            m3u8Url = m3u8Res.data.sources[0]?.file;
                            tracks = m3u8Res.data.tracks || [];
                        }
                    }
                }
            } catch (e) {
                console.log('M3U8 extraction failed:', e.message);
            }
            
            // Fallback to embed URL
            if (!m3u8Url && embedLink) {
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

// Stream endpoint (alias for sources)
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
            try {
                const key = await getDecryptionKey();
                const decrypted = await decryptSources(embedLink, key);
                
                if (decrypted && decrypted.sources && decrypted.sources[0]?.file) {
                    m3u8Url = decrypted.sources[0].file;
                    tracks = decrypted.tracks || [];
                }
            } catch (e) {
                console.log('Stream decryption failed:', e.message);
            }
            
            if (!m3u8Url) {
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
