const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const sources = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

sources.use(cors());

const BASE_URLS = [
    'https://aniwatchtv.to',
    'https://aniwatch.to',
];

// Use user's working API
const WORKING_API = 'https://aniwatch-ifaorkapi.vercel.app';

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

sources.get('/', async (req, res) => {
    const { id, server, category } = req.query;
    
    if (!id) {
        return res.status(400).json({ error: 'Episode ID required' });
    }
    
    console.log('Getting sources for:', id, 'server:', server, 'category:', category);
    
    try {
        // Parse anime ID and episode ID
        const episodeMatch = id.match(/ep=(\d+)/);
        const episodeId = episodeMatch ? episodeMatch[1] : id.match(/\d+/)?.[0];
        const animeIdMatch = id.match(/^(.+?)(?:\?ep=|\?server)/);
        const animeId = animeIdMatch ? animeIdMatch[1] : id.split('?')[0];
        
        if (!episodeId || !animeId) {
            return res.status(400).json({ error: 'Invalid ID format. Use: anime-id?ep=episode-id' });
        }
        
        console.log('Anime ID:', animeId, 'Episode ID:', episodeId);
        
        // First get servers list from aniwatch
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
        
        // Get stream from working API
        const apiType = category === 'dub' ? 'dub' : 'sub';
        const streamUrl = `${WORKING_API}/api/stream?id=${animeId}?ep=${episodeId}&server=hd-1&type=${apiType}`;
        
        console.log('Calling working API:', streamUrl);
        
        let m3u8Url = null;
        let tracks = [];
        let intro = null;
        let outro = null;
        
        try {
            const streamRes = await axios.get(streamUrl, { timeout: 30000 });
            
            if (streamRes.data?.success && streamRes.data?.results?.streamingLink) {
                const link = streamRes.data.results.streamingLink;
                m3u8Url = link.link?.file || null;
                tracks = link.tracks || [];
                intro = link.intro?.start || null;
                outro = link.intro?.end || null;
                console.log('Got m3u8 from working API!');
            } else {
                console.log('Working API returned no stream');
            }
        } catch (apiErr) {
            console.log('Working API error:', apiErr.message);
        }
        
        // Fallback to embed URL if no m3u8
        let embedLink = null;
        if (!m3u8Url) {
            try {
                const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
                const { data: sourceData } = await fetchWithFallback(BASE_URLS, sourceUrl);
                embedLink = sourceData.link;
            } catch (e) {
                console.log('Failed to get embed link:', e.message);
            }
        }
        
        const isEmbedUrl = embedLink && m3u8Url === embedLink;
        
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : (embedLink ? [{ url: embedLink, type: 'embed' }] : []),
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
