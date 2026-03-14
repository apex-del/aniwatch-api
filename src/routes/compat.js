// API compatibility layer - returns data in same format as old HiAnime API

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const compat = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

compat.use(cors());

const BASE_URLS = ['https://aniwatchtv.to', 'https://aniwatch.to'];

// Helper to fetch with fallback
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

// Get anime info - compatible format
compat.get('/anime/:id', async (req, res) => {
    const animeId = req.params.id;
    
    try {
        const url = `/${animeId}`;
        const response = await axios.get(`${BASE_URLS[0]}${url}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        const $ = cheerio.load(response.data);
        
        // Extract info in same format as old API
        const info = {};
        const stats = {};
        
        // Get name
        info.name = $('.film-name.dynamic-name').text().trim() || animeId;
        
        // Get poster
        const poster = $('.film-poster img').attr('src') || '';
        
        // Get episodes
        const epSub = $('.tick-sub').text().trim() || '0';
        const epDub = $('.tick-dub').text().trim() || '0';
        stats.episodes = { sub: epSub, dub: epDub, eps: epSub };
        
        // Get other info
        info.type = $('.film-info .item:eq(0)').text().trim() || 'TV';
        const duration = $('.film-info .item:eq(1)').text().trim() || '24m';
        stats.duration = duration;
        stats.quality = $('.tick-quality').text().trim() || 'HD';
        stats.rating = $('.tick-pg').text().trim() || 'PG-13';
        
        // Get description
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
        // Get anime page to find episode list ID
        const animeUrl = `/${animeId}`;
        const animeRes = await axios.get(`${BASE_URLS[0]}${animeUrl}`, {
            headers: { 'User-Agent': USER_AGENT }
        });
        
        const $ = cheerio.load(animeRes.data);
        const episodeId = $('#syncData').text().match(/episodeId":"(\d+)"/)?.[1];
        
        if (!episodeId) {
            return res.json({ data: { episodes: [] } });
        }
        
        // Get episodes
        const epUrl = `/ajax/v2/episode/list/${episodeId}`;
        const epRes = await fetchWithFallback([epUrl]);
        
        if (!epRes) {
            return res.json({ data: { episodes: [] } });
        }
        
        const $$ = cheerio.load(epRes.data.html || epRes.data);
        const episodes = [];
        
        $$('.ssl-item.ep-item').each(function(i) {
            const epNum = $$(this).find('.ssli-order').text().trim();
            const epName = $$(this).find('.e-dynamic-name').text().trim();
            const epLink = $$(this).attr('href') || '';
            const epIdMatch = epLink.match(/ep=(\d+)/);
            
            episodes.push({
                number: parseInt(epNum) || i + 1,
                title: epName,
                episodeId: epIdMatch ? epIdMatch[1] : ''
            });
        });
        
        res.json({ data: { episodes } });
        
    } catch (e) {
        console.error('Episodes error:', e.message);
        res.json({ data: { episodes: [] } });
    }
});

// Get episode sources - compatible format
compat.get('/episode/sources', async (req, res) => {
    const { animeEpisodeId, server, category } = req.query;
    
    if (!animeEpisodeId) {
        return res.status(400).json({ error: 'animeEpisodeId required' });
    }
    
    try {
        // Get servers
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
        
        // Select server (vidsrc, megacloud, t-cloud)
        let selectedServer = servers[0];
        if (server === 'hd-1') {
            selectedServer = servers.find(s => s.name.includes('vidsrc')) || servers[0];
        } else if (server === 'hd-2') {
            selectedServer = servers.find(s => s.name.includes('mega')) || servers[0];
        }
        
        if (!selectedServer) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        // Get source link
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const sourceRes = await fetchWithFallback([sourceUrl]);
        
        if (!sourceRes) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        let embedLink = sourceRes.data.link;
        let m3u8Url = null;
        let tracks = [];
        
        // Try to get m3u8 from embed
        if (embedLink) {
            const embedDomain = embedLink.match(/https?:\/\/[^/]+/)?.[0] || 'https://megacloud.blog';
            const embedId = embedLink.split('/e-1/')[1]?.split('?')[0];
            
            if (embedId) {
                try {
                    const m3u8UrlFull = `${embedDomain}/getSources?id=${embedId}`;
                    const m3u8Res = await axios.get(m3u8UrlFull, {
                        headers: {
                            'User-Agent': USER_AGENT,
                            'X-Requested-With': 'XMLHttpRequest',
                            'Referer': embedLink
                        },
                        timeout: 15000
                    }).catch(() => null);
                    
                    if (m3u8Res?.data?.sources) {
                        m3u8Url = m3u8Res.data.sources[0]?.file;
                        tracks = m3u8Res.data.tracks || [];
                    }
                } catch (e) {
                    console.log('M3U8 extraction failed:', e.message);
                }
            }
        }
        
        // Return in same format as old API
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : [],
                embed: embedLink,
                tracks: tracks,
                serverInfo: selectedServer
            }
        });
        
    } catch (e) {
        console.error('Sources error:', e.message);
        res.json({ data: { sources: [], tracks: [] } });
    }
});

module.exports = compat;