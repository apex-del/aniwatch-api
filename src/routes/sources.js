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
const KEY_URL = 'https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt';
const KEY_ALT_URL = 'https://gist.githubusercontent.com/eggwite/main/raw/key.txt';

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
        console.log('Primary key URL failed, trying alternative...');
        try {
            const { data: key } = await axios.get(KEY_ALT_URL, { timeout: 5000 });
            cachedKey = key.trim();
            keyLastFetched = now;
            return cachedKey;
        } catch (error2) {
            console.log('Alternative key URL also failed');
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
        const results = {};

        const meta = $('meta[name="_gg_fb"]').attr('content');
        if (meta && meta.length >= 10) {
            return meta;
        }

        const dpi = $('[data-dpi]').attr('data-dpi');
        if (dpi && dpi.length >= 10) {
            return dpi;
        }

        const nonceScript = $('script[nonce]')
            .filter((i, el) => $(el).text().includes('empty nonce script') || $(el).text().includes('nonce'))
            .attr('nonce');
        if (nonceScript && nonceScript.length >= 10) {
            return nonceScript;
        }

        const stringAssignRegex = /window\.(\w+)\s*=\s*["']([a-zA-Z0-9_-]{10,})["']/g;
        const stringMatches = [...html.matchAll(stringAssignRegex)];
        for (const [, key, value] of stringMatches) {
            if (value.length >= 10) return value;
        }

        throw new Error('No token found');
    } catch (error) {
        console.log('Token extraction error:', error.message);
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
        
        const sourceUrl = `/ajax/v2/episode/sources?id=${selectedServer.id}`;
        const { data: sourceData } = await fetchWithFallback(BASE_URLS, sourceUrl);
        
        let embedLink = sourceData.link;
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
                    console.log('Decryption returned no sources, trying direct...');
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
                console.log('Megacloud decryption failed:', e.message);
            }
            
            // Fallback: return embed URL if no m3u8 found (for iframe embedding)
            if (!m3u8Url) {
                m3u8Url = embedLink;
            }
        }
        
        // Determine if it's an m3u8 or embed URL
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
