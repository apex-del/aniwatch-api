const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const server = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

server.use(cors());

// Try different base URLs (same backend)
const BASE_URLS = [
    'https://aniwatchtv.to',
    'https://aniwatch.to',
    'https://hianime.to',
];

async function fetchServers(episodeId) {
    const errors = [];
    
    for (const baseUrl of BASE_URLS) {
        try {
            const url = `${baseUrl}/ajax/v2/episode/servers?episodeId=${episodeId}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Referer': `${baseUrl}/watch/`,
                },
                timeout: 10000
            });
            
            if (response.data && response.data.html) {
                return { html: response.data.html, baseUrl };
            }
        } catch (e) {
            errors.push(`${baseUrl}: ${e.message}`);
            continue;
        }
    }
    
    throw new Error(`All sources failed: ${errors.join(', ')}`);
}

server.get('/server/:id', async (req, res) => {
    const episodeMatch = req.params.id.match(/\d+/);
    if (!episodeMatch) {
        return res.status(400).json({ error: 'Invalid episode ID' });
    }
    const episodeId = episodeMatch[0];
    
    try {
        const { html, baseUrl } = await fetchServers(episodeId);
        const $ = cheerio.load(html);
        
        const sub = [];
        const dub = [];
        
        // Parse SUB servers
        $('.servers-sub .server-item').each(function() {
            const serverName = $(this).find('a').text().trim().toLowerCase();
            const serverId = $(this).attr('data-id');
            const serverIndex = $(this).attr('data-server-id');
            sub.push({ server: serverName, id: serverId, srcId: serverId });
        });
        
        // Parse DUB servers
        $('.servers-dub .server-item').each(function() {
            const serverName = $(this).find('a').text().trim().toLowerCase();
            const serverId = $(this).attr('data-id');
            const serverIndex = $(this).attr('data-server-id');
            dub.push({ server: serverName, id: serverId, srcId: serverId });
        });
        
        res.json({ sub, dub, source: baseUrl });
    } catch (error) {
        console.error('Server fetch error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = server;

