const express = require('express');
const axios = require("axios");
const crypto = require("crypto");

const src1 = express();

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";

// Different megacloud domains to try
const MEGACLOUD_DOMAINS = [
    'https://megacloud.tv',
    'https://megacloud.blog', 
    'https://megacloud.co',
    'https://mega.cloud',
];

async function getSourceLink(serverId, serverType = 'sub') {
    const errors = [];
    
    for (const domain of MEGACLOUD_DOMAINS) {
        try {
            const url = `${domain}/ajax/v2/episode/sources?id=${serverId}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${domain}/`
                },
                timeout: 10000
            });
            
            // The response might be coming as a function wrapper
            // Check if it's a string that needs parsing
            let data = response.data;
            if (typeof data === 'string') {
                // Try to extract JSON from string
                const jsonMatch = data.match(/\{.+\}/);
                if (jsonMatch) {
                    data = JSON.parse(jsonMatch[0]);
                }
            }
            
            if (data && data.link) {
                return {
                    link: data.link,
                    domain: domain,
                    server: data.server
                };
            }
        } catch (e) {
            errors.push(`${domain}: ${e.message}`);
            continue;
        }
    }
    
    throw new Error(`All sources failed: ${errors.join(', ')}`);
}

async function extractM3u8(embedLink) {
    if (!embedLink) return null;
    
    // Extract domain from embed link
    const match = embedLink.match(/https?:\/\/[^\/]+/);
    if (!match) return null;
    const embedDomain = match[0];
    
    try {
        // Try to get sources from the embed
        const embedId = embedLink.split('/e-1/')[1]?.split('?')[0];
        if (!embedId) return null;
        
        const url = `${embedDomain}/getSources?id=${embedId}`;
        const response = await axios.get(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': embedLink
            },
            timeout: 15000
        });
        
        if (response.data && response.data.sources) {
            return response.data.sources;
        }
    } catch (e) {
        console.log('M3U8 extract error:', e.message);
    }
    
    return null;
}

src1.get('/src-server/:id', async (req, res) => {
    try {
        const srcId = req.params.id;
        console.log('Getting stream for srcId:', srcId);
        
        // Step 1: Get source link from any available domain
        const sourceData = await getSourceLink(srcId);
        
        if (!sourceData.link) {
            return res.status(404).json({ error: 'No source link found' });
        }
        
        // Ensure link is a string
        const embedLink = typeof sourceData.link === 'string' ? sourceData.link : String(sourceData.link);
        console.log('Got embed link:', embedLink);
        
        // Step 2: Try to extract m3u8 from embed
        const sources = await extractM3u8(embedLink);
        
        if (sources && sources.length > 0) {
            return res.json({
                serverSrc: [{
                    rest: sources.map(s => ({ file: s.file, type: s.type }))
                }],
                embed: embedLink,
                server: sourceData.server
            });
        }
        
        // If extraction failed, return the embed link for reference
        res.json({
            serverSrc: [],
            embed: embedLink,
            server: sourceData.server,
            message: 'Direct sources unavailable, embed link returned'
        });
        
    } catch (error) {
        console.error('Stream error:', error.message);
        res.status(500).json({ error: 'Failed to get stream: ' + error.message });
    }
});

module.exports = src1;
