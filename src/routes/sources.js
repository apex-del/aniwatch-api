const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const sources = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

sources.use(cors());

// Same backend sources
const BASE_URLS = [
    'https://aniwatchtv.to',
    'https://aniwatch.to',
];

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

// Get streaming sources for an episode - compatible with old HiAnime API format
// Query params: id (episode ID), server (hd-1, hd-2), category (sub, dub)
sources.get('/', async (req, res) => {
    const { id, server, category } = req.query;
    
    if (!id) {
        return res.status(400).json({ error: 'Episode ID required' });
    }
    
    console.log('Getting sources for:', id, 'server:', server, 'category:', category);
    
    try {
        // Extract episode ID from param (e.g., "one-piece-100?ep=2187" -> "2187")
        const episodeMatch = id.match(/ep=(\d+)/);
        const episodeId = episodeMatch ? episodeMatch[1] : id.match(/\d+/)?.[0];
        
        if (!episodeId) {
            return res.status(400).json({ error: 'Invalid episode ID format' });
        }
        
        // Get servers for this episode
        const serversUrl = `/ajax/v2/episode/servers?episodeId=${episodeId}`;
        const { data: serverData } = await fetchWithFallback(BASE_URLS, serversUrl);
        
        // Parse server list
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
        
        // Select server based on category
        const targetServers = (category === 'dub') ? dubServers : subServers;
        
        // Select server (default: first available)
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
        
        // Get source link from server
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const { data: sourceData } = await fetchWithFallback(BASE_URLS, sourceUrl);
        
        let embedLink = sourceData.link;
        
        // Try to extract m3u8 from embed
        let m3u8Url = null;
        let tracks = [];
        
        if (embedLink) {
            const embedDomain = embedLink.match(/https?:\/\/[^/]+/)?.[0] || 'https://megacloud.blog';
            const embedId = embedLink.split('/e-1/')[1]?.split('?')[0];
            
            if (embedId) {
                try {
                    const m3u8UrlFinal = `${embedDomain}/getSources?id=${embedId}`;
                    const m3u8Res = await axios.get(m3u8UrlFinal, {
                        headers: {
                            'User-Agent': USER_AGENT,
                            'X-Requested-With': 'XMLHttpRequest',
                            'Referer': embedLink
                        },
                        timeout: 15000
                    });
                    
                    if (m3u8Res.data && m3u8Res.data.sources) {
                        m3u8Url = m3u8Res.data.sources[0]?.file;
                        tracks = m3u8Res.data.tracks || [];
                    }
                } catch (e) {
                    console.log('Could not extract m3u8:', e.message);
                }
            }
        }
        
        // Return in format compatible with old HiAnime API
        res.json({
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : [],
                embed: embedLink,
                server: selectedServer.name,
                tracks: tracks,
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