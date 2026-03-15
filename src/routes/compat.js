// API compatibility layer - uses working API

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const compat = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

compat.use(cors());

const BASE_URLS = ['https://aniwatchtv.to', 'https://aniwatch.to'];
const WORKING_API = 'https://aniwatch-ifaorkapi.vercel.app';

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

// Get anime info
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

// Get episodes list
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

// Get episode sources using working API
compat.get('/episode/sources', async (req, res) => {
    const { animeEpisodeId, server, category } = req.query;
    
    if (!animeEpisodeId) {
        return res.status(400).json({ error: 'animeEpisodeId required' });
    }
    
    try {
        // Parse IDs
        const episodeMatch = animeEpisodeId.match(/ep=(\d+)/);
        const episodeId = episodeMatch ? episodeMatch[1] : animeEpisodeId.match(/\d+/)?.[0];
        const animeIdMatch = animeEpisodeId.match(/^(.+?)(?:\?ep=|\?server)/);
        const animeId = animeIdMatch ? animeIdMatch[1] : animeEpisodeId.split('?')[0];
        
        if (!episodeId || !animeId) {
            return res.json({ data: { sources: [], tracks: [] } });
        }
        
        // Get servers
        const serversUrl = `/ajax/v2/episode/servers?episodeId=${episodeId}`;
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
        
        // Get stream from working API
        const apiType = type === 'dub' ? 'dub' : 'sub';
        const streamUrl = `${WORKING_API}/api/stream?id=${animeId}?ep=${episodeId}&server=hd-1&type=${apiType}`;
        
        let m3u8Url = null;
        let tracks = [];
        let intro = null;
        let outro = null;
        let embedLink = null;
        
        try {
            const streamRes = await axios.get(streamUrl, { timeout: 30000 });
            if (streamRes.data?.success && streamRes.data?.results?.streamingLink) {
                const link = streamRes.data.results.streamingLink;
                m3u8Url = link.link?.file || null;
                tracks = link.tracks || [];
                intro = link.intro?.start || null;
                outro = link.intro?.end || null;
            }
        } catch (e) {
            console.log('Working API error:', e.message);
        }
        
        // Fallback
        if (!m3u8Url) {
            try {
                const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
                const sourceRes = await fetchWithFallback([sourceUrl]);
                if (sourceRes) {
                    embedLink = sourceRes.data.link;
                }
            } catch (e) {}
        }
        
        const isEmbed = m3u8Url === embedLink || !m3u8Url;
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : (embedLink ? [{ url: embedLink, type: 'embed' }] : []),
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
    const animeIdMatch = id.match(/^(.+?)(?:\?ep=)/);
    const animeId = animeIdMatch ? animeIdMatch[1] : id.split('?')[0];
    
    if (!episodeId || !animeId) {
        return res.status(400).json({ error: 'Invalid ID format' });
    }
    
    try {
        const apiType = type === 'dub' ? 'dub' : 'sub';
        const streamUrl = `${WORKING_API}/api/stream?id=${animeId}?ep=${episodeId}&server=hd-1&type=${apiType}`;
        
        let m3u8Url = null;
        let tracks = [];
        
        try {
            const streamRes = await axios.get(streamUrl, { timeout: 30000 });
            if (streamRes.data?.success && streamRes.data?.results?.streamingLink) {
                const link = streamRes.data.results.streamingLink;
                m3u8Url = link.link?.file || null;
                tracks = link.tracks || [];
            }
        } catch (e) {
            console.log('Stream API error:', e.message);
        }
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : [],
                tracks: tracks,
            }
        });
        
    } catch (e) {
        console.error('Stream error:', e.message);
        res.json({ data: { sources: [], tracks: [] } });
    }
});

module.exports = compat;
