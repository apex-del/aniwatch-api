const express = require('express');
const axios = require("axios");

const src1 = express();

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

// Use aniwatchtv.to as primary source (same backend as hianime)
const ANIME_SOURCES = [
    'https://aniwatchtv.to',
    'https://aniwatch.to',
];

async function getSourceLink(serverId) {
    const errors = [];
    
    for (const domain of ANIME_SOURCES) {
        try {
            const url = `${domain}/ajax/v2/episode/sources?id=${serverId}`;
            console.log('Trying:', url);
            
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${domain}/watch/`
                },
                timeout: 15000
            });
            
            console.log('Response:', response.data);
            
            let data = response.data;
            
            // Handle string responses
            if (typeof data === 'string') {
                const jsonMatch = data.match(/\{.+\}/s);
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[0]);
                }
            }
            
            if (data && data.link) {
                return {
                    link: data.link,
                    domain: domain,
                    server: data.server,
                    sources: data.sources || [],
                    tracks: data.tracks || []
                };
            }
        } catch (e) {
            console.log('Error from', domain, ':', e.message);
            errors.push(`${domain}: ${e.message}`);
            continue;
        }
    }
    
    throw new Error(`All sources failed: ${errors.join(', ')}`);
}

src1.get('/src-server/:id', async (req, res) => {
    try {
        const srcId = req.params.id;
        console.log('Getting stream for srcId:', srcId);
        
        const sourceData = await getSourceLink(srcId);
        
        if (!sourceData.link) {
            return res.status(404).json({ error: 'No source link found' });
        }
        
        const embedLink = sourceData.link;
        console.log('Got embed link:', embedLink);
        
        // If direct sources are available in the response, use them
        if (sourceData.sources && sourceData.sources.length > 0) {
            return res.json({
                serverSrc: [{
                    rest: sourceData.sources.map(s => ({ file: s.file, type: s.type }))
                }],
                embed: embedLink,
                server: sourceData.server,
                tracks: sourceData.tracks
            });
        }
        
        // Otherwise, try to extract from embed
        // Extract embed domain and ID
        const embedMatch = embedLink.match(/https?:\/\/[^/]+\/embed[^/]+\/([^?]+)/);
        if (!embedMatch) {
            return res.json({
                serverSrc: [],
                embed: embedLink,
                server: sourceData.server,
                message: 'Embed link returned, direct sources unavailable'
            });
        }
        
        const embedDomain = embedLink.match(/https?:\/\/[^/]+/)[0];
        const embedId = embedMatch[1];
        
        // Try to get sources from embed
        try {
            const sourcesUrl = `${embedDomain}/getSources?id=${embedId}`;
            const sourcesRes = await axios.get(sourcesUrl, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': embedLink
                },
                timeout: 15000
            });
            
            if (sourcesRes.data && sourcesRes.data.sources) {
                return res.json({
                    serverSrc: [{
                        rest: sourcesRes.data.sources.map(s => ({ file: s.file, type: s.type }))
                    }],
                    embed: embedLink,
                    server: sourceData.server,
                    tracks: sourcesRes.data.tracks
                });
            }
        } catch (e) {
            console.log('Failed to extract from embed:', e.message);
        }
        
        // Return embed link if everything else fails
        res.json({
            serverSrc: [],
            embed: embedLink,
            server: sourceData.server,
            message: 'Could not extract direct sources'
        });
        
    } catch (error) {
        console.error('Stream error:', error.message);
        res.status(500).json({ error: 'Failed to get stream: ' + error.message });
    }
});

module.exports = src1;
