const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const hianime = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";
const BASE_URLS = ['https://aniwatchtv.to', 'https://aniwatch.to'];
const MEGACLOUD_BASE = 'https://megacloud.tv';
const KEY_URL = 'https://raw.githubusercontent.com/ryanwtf88/megacloud-keys/refs/heads/master/key.txt';
const KEY_ALT_URL = 'https://gist.githubusercontent.com/eggwite/main/raw/key.txt';
const PROXY_URL = 'https://hianime-api-proxy.anonymous-0709200.workers.dev';

let cachedKey = null;
let keyLastFetched = 0;
const KEY_CACHE_DURATION = 3600000;

hianime.use(cors());

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
        let fetchUrl = url;
        let useProxy = url.includes('megacloud');
        
        if (useProxy) {
            fetchUrl = `${PROXY_URL}/?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(MEGACLOUD_BASE + '/')}`;
        }
        
        const { data: html } = await axios.get(fetchUrl, {
            headers: useProxy ? {} : {
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

        const isMegacloud = embedDomain.includes('megacloud');
        
        const tokenUrl = `${embedDomain}/${embedId}?k=1&autoPlay=0&oa=0&asi=1`;
        const token = await extractToken(tokenUrl);
        
        if (!token) {
            throw new Error('Failed to extract token');
        }

        let sourcesUrl;
        if (isMegacloud) {
            sourcesUrl = `${PROXY_URL}/?url=${encodeURIComponent(`${embedDomain}/getSources?id=${embedId}&_k=${token}`)}&referer=${encodeURIComponent(embedLink)}`;
        } else {
            sourcesUrl = `${embedDomain}/getSources?id=${embedId}&_k=${token}`;
        }
        
        const { data } = await axios.get(sourcesUrl, {
            headers: isMegacloud ? {} : {
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': `${embedDomain}/${embedId}`,
            },
            timeout: 15000
        });

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

async function fetchWithFallback(path, params = {}) {
    for (const baseUrl of BASE_URLS) {
        try {
            const url = `${baseUrl}${path}`;
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': baseUrl + '/'
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

function parseAnimeItem(element, $) {
    return {
        id: $(element).find('.film-name a').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
        name: $(element).find('.dynamic-name').text().trim() || null,
        jname: $(element).find('.dynamic-name').attr('data-jname') || null,
        poster: $(element).find('.film-poster img').attr('data-src') || $(element).find('.film-poster img').attr('src') || null,
        duration: $(element).find('.fdi-duration').text().trim() || null,
        quality: $(element).find('.tick-quality').text().trim() || null,
        sub: $(element).find('.tick-sub').text().trim() || '0',
        dub: $(element).find('.tick-dub').text().trim() || '0',
        episodes: $(element).find('.tick-eps').text().trim() || null,
        type: $(element).find('.fdi-item:first').text().trim() || null,
        rating: $(element).find('.tick-rate').text().trim() || null,
    };
}

function parseAnimeDetail($, url) {
    const anime = {};
    
    anime.id = url.split('/')[1]?.split('?')[0] || null;
    anime.name = $('.film-name.dynamic-name').text().trim() || null;
    anime.jname = $('.film-name.dynamic-name').attr('data-jname') || null;
    anime.poster = $('.film-poster img').attr('src') || $('.film-poster img').attr('data-src') || null;
    anime.description = $('.description .text').text().trim() || null;
    anime.type = $('.film-info .item:eq(0)').text().trim() || null;
    anime.duration = $('.film-info .item:eq(1)').text().trim() || null;
    anime.status = $('.film-info .item:eq(2)').text().trim() || null;
    anime.quality = $('.tick-quality').text().trim() || null;
    anime.rating = $('.tick-pg').text().trim() || null;
    
    anime.episodes = {
        sub: $('.tick-sub').text().trim() || '0',
        dub: $('.tick-dub').text().trim() || '0',
        eps: $('.tick-eps').text().trim() || '0'
    };
    
    const genres = [];
    $('.genres .item-list a').each((i, el) => {
        genres.push({
            name: $(el).text().trim(),
            id: $(el).attr('href')?.split('/genre/')[1] || null
        });
    });
    anime.genres = genres;
    
    const studios = [];
    $('.producer .name').each((i, el) => {
        studios.push($(el).text().trim());
    });
    anime.studios = studios;
    
    anime.releaseDate = $('.meta-row .name:contains("Released:")').text().replace('Released:', '').trim() || null;
    anime.malScore = $('.rates .rate .value').text().trim() || null;
    
    const seasons = [];
    $('.os-list a').each((i, el) => {
        seasons.push({
            id: $(el).attr('href')?.split('/')[1] || null,
            name: $(el).text().trim()
        });
    });
    anime.seasons = seasons;
    
    const recommendations = [];
    $('.film_list-wrap .flw-item').each((i, el) => {
        if (i >= 12) return;
        recommendations.push({
            id: $(el).find('a').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
            name: $(el).find('.dynamic-name').text().trim() || null,
            jname: $(el).find('.dynamic-name').attr('data-jname') || null,
            poster: $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || null,
            type: $(el).find('.fdi-item:first').text().trim() || null,
            duration: $(el).find('.fdi-duration').text().trim() || null,
            sub: $(el).find('.tick-sub').text().trim() || '0',
            dub: $(el).find('.tick-dub').text().trim() || '0',
        });
    });
    anime.recommendations = recommendations;
    
    return anime;
}

// HOME - Get homepage content
hianime.get('/home', async (req, res) => {
    try {
        const result = await fetchWithFallback('/home');
        if (!result) return res.status(500).json({ error: 'Failed to fetch home' });
        
        const $ = cheerio.load(result.data);
        
        const featured = [];
        $('.deslide-item').each((i, el) => {
            if (i >= 8) return;
            featured.push({
                id: $(el).find('.desi-buttons a:eq(1)').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
                name: $(el).find('.dynamic-name').text().trim() || null,
                jname: $(el).find('.dynamic-name').attr('data-jname') || null,
                poster: $(el).find('.deslide-cover-img img').attr('data-src') || null,
                background: $(el).find('.deslide-bg img').attr('data-src') || null,
                description: $(el).find('.desi-description').text().trim() || null,
                type: $(el).find('.scd-item:eq(0)').text().trim() || null,
                duration: $(el).find('.scd-item:eq(1)').text().trim() || null,
                quality: $(el).find('.scd-item:eq(3)').text().trim() || null,
            });
        });
        
        const trending = [];
        $('.swiper-slide.item-qtip').each((i, el) => {
            if (i >= 10) return;
            trending.push({
                id: $(el).find('.film-name a').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
                name: $(el).find('.dynamic-name').text().trim() || null,
                jname: $(el).find('.dynamic-name').attr('data-jname') || null,
                poster: $(el).find('.film-poster img').attr('data-src') || null,
                ranking: i + 1,
            });
        });
        
        const latest = [];
        $('.cat-headi:contains("Latest Updated")').closest('.tab-content').find('.flw-item').each((i, el) => {
            if (i >= 18) return;
            latest.push(parseAnimeItem(el, $));
        });
        
        const topAiring = [];
        $('.cat-headi:contains("Top Airing")').closest('.tab-content').find('.flw-item').each((i, el) => {
            if (i >= 18) return;
            topAiring.push(parseAnimeItem(el, $));
        });
        
        const movie = [];
        $('.cat-headi:contains("Anime Movies")').closest('.tab-content').find('.flw-item').each((i, el) => {
            if (i >= 12) return;
            movie.push(parseAnimeItem(el, $));
        });
        
        res.json({
            success: true,
            data: {
                featured,
                trending,
                latestUpdated: latest,
                topAiring,
                movies: movie
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SEARCH - Search anime
hianime.get('/search', async (req, res) => {
    const { keyword, page = 1 } = req.query;
    if (!keyword) return res.status(400).json({ error: 'Keyword required' });
    
    try {
        const result = await fetchWithFallback(`/search?keyword=${encodeURIComponent(keyword)}&page=${page}`);
        if (!result) return res.status(500).json({ error: 'Search failed' });
        
        const $ = cheerio.load(result.data);
        
        const results = [];
        $('.flw-item').each((i, el) => {
            results.push(parseAnimeItem(el, $));
        });
        
        const totalPages = $('.pagination .page-item a').length > 0 
            ? parseInt($('.pagination .page-item a').last().attr('href')?.split('page=')[1]) || 1 
            : 1;
        
        res.json({
            success: true,
            data: {
                results,
                currentPage: parseInt(page),
                totalPages,
                totalResults: results.length
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SUGGESTION - Get search suggestions
hianime.get('/suggestion', async (req, res) => {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: 'Keyword required' });
    
    try {
        const result = await fetchWithFallback(`/search?keyword=${encodeURIComponent(keyword)}`);
        if (!result) return res.status(500).json({ error: 'Suggestions failed' });
        
        const $ = cheerio.load(result.data);
        
        const suggestions = [];
        $('.flw-item').each((i, el) => {
            if (i >= 8) return;
            suggestions.push({
                id: $(el).find('.film-name a').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
                name: $(el).find('.dynamic-name').text().trim() || null,
                jname: $(el).find('.dynamic-name').attr('data-jname') || null,
                poster: $(el).find('.film-poster img').attr('data-src') || null,
                type: $(el).find('.fdi-item:first').text().trim() || null,
            });
        });
        
        res.json({ success: true, data: suggestions });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GENRES - Get all genres
hianime.get('/genres', async (req, res) => {
    try {
        const result = await fetchWithFallback('/home');
        if (!result) return res.status(500).json({ error: 'Failed to fetch genres' });
        
        const $ = cheerio.load(result.data);
        
        const genres = [];
        $('.genres .item-list a').each((i, el) => {
            genres.push({
                name: $(el).text().trim(),
                id: $(el).attr('href')?.split('/genre/')[1] || null,
            });
        });
        
        res.json({ success: true, data: genres });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ANIMES BY GENRE
hianime.get('/animes/genre/:genre', async (req, res) => {
    const { genre } = req.params;
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/genre/${genre}?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch genre' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        const topItems = [];
        $('.top-anime .flw-item').each((i, el) => {
            topItems.push(parseAnimeItem(el, $));
        });
        
        res.json({
            success: true,
            data: {
                animes,
                topItems,
                genre: genre
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ANIMES BY PRODUCER
hianime.get('/animes/producer/:producer', async (req, res) => {
    const { producer } = req.params;
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/producer/${producer}?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch producer' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, producer } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ANIME DETAIL
hianime.get('/anime/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await fetchWithFallback(`/${id}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch anime' });
        
        const $ = cheerio.load(result.data);
        const anime = parseAnimeDetail($, `/${id}`);
        
        res.json({ success: true, data: { anime } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// EPISODES LIST
hianime.get('/episodes/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const animeId = id.match(/\d+/)?.[0];
        if (!animeId) return res.status(400).json({ error: 'Invalid anime ID' });
        
        const result = await fetchWithFallback(`/ajax/v2/episode/list/${animeId}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch episodes' });
        
        const $ = cheerio.load(result.data.html || '');
        
        const episodes = [];
        $('.ssl-item.ep-item').each((i, el) => {
            const epId = $(el).attr('href') || '';
            episodes.push({
                number: parseInt($(el).find('.ssli-order').text().trim()) || i + 1,
                title: $(el).find('.e-dynamic-name').text().trim() || null,
                episodeId: epId.split('ep=')[1] || epId.split('/watch/')[1] || null,
                isFiller: $(el).hasClass('filler'),
            });
        });
        
        res.json({ success: true, data: { episodes } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SERVERS - Get available servers
hianime.get('/servers', async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Episode ID required' });
    
    try {
        const result = await fetchWithFallback(`/ajax/v2/episode/servers?episodeId=${id}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch servers' });
        
        const $ = cheerio.load(result.data.html || '');
        
        const servers = { sub: [], dub: [] };
        
        $('.servers-sub .server-item').each((i, el) => {
            servers.sub.push({
                id: $(el).attr('data-id'),
                name: $(el).find('a').text().trim(),
            });
        });
        
        $('.servers-dub .server-item').each((i, el) => {
            servers.dub.push({
                id: $(el).attr('data-id'),
                name: $(el).find('a').text().trim(),
            });
        });
        
        res.json({ success: true, data: servers });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// STREAM - Get video stream
hianime.get('/stream', async (req, res) => {
    const { id, server = 'hd-1', type = 'sub' } = req.query;
    if (!id) return res.status(400).json({ error: 'Episode ID required' });
    
    try {
        const serversResult = await fetchWithFallback(`/ajax/v2/episode/servers?episodeId=${id}`);
        if (!serversResult) return res.status(500).json({ error: 'Failed to get servers' });
        
        const $ = cheerio.load(serversResult.data.html || '');
        
        const targetServers = type === 'dub' ? '.servers-dub' : '.servers-sub';
        const servers = [];
        
        $(`${targetServers} .server-item`).each((i, el) => {
            servers.push({
                id: $(el).attr('data-id'),
                name: $(el).find('a').text().trim().toLowerCase()
            });
        });
        
        let selectedServer = servers[0];
        if (server === 'hd-1' || server === 'vidsrc') {
            selectedServer = servers.find(s => s.name.includes('vidsrc')) || servers[0];
        } else if (server === 'hd-2' || server === 'megacloud') {
            selectedServer = servers.find(s => s.name.includes('mega')) || servers[0];
        } else if (server === 'hd-3' || server === 'streamtape') {
            selectedServer = servers.find(s => s.name.includes('streamtape')) || servers[0];
        }
        
        if (!selectedServer) {
            return res.status(404).json({ error: 'No servers available' });
        }
        
        const sourceResult = await fetchWithFallback(`/ajax/v2/episode/sources?id=${selectedServer.id}`);
        if (!sourceResult) return res.status(500).json({ error: 'Failed to get source' });
        
        let embedLink = sourceResult.data.link;
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
            
            if (!m3u8Url && embedLink) {
                m3u8Url = embedLink;
            }
        }
        
        const isEmbedUrl = embedLink && m3u8Url === embedLink;
        
        res.json({
            success: true,
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: isEmbedUrl ? 'embed' : 'hls' }] : [],
                embed: embedLink,
                server: selectedServer.name,
                tracks: tracks,
                intro: intro,
                outro: outro,
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// RANDOM - Get random anime
hianime.get('/random', async (req, res) => {
    try {
        const result = await fetchWithFallback('/random');
        if (!result) return res.status(500).json({ error: 'Failed to get random' });
        
        const $ = cheerio.load(result.data);
        const anime = parseAnimeDetail($, '/random');
        
        res.json({ success: true, data: { anime } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SCHEDULES - Get anime schedule
hianime.get('/schedules', async (req, res) => {
    const { date } = req.query;
    
    try {
        const targetDate = date || new Date().toISOString().split('T')[0];
        const result = await fetchWithFallback(`/ajax/schedule/list?tzOffset=-330&date=${targetDate}`);
        if (!result) return res.status(500).json({ error: 'Failed to get schedule' });
        
        const $ = cheerio.load(result.data.html || '');
        
        const schedule = [];
        $('li').each((i, el) => {
            schedule.push({
                id: $(el).find('.dynamic-name').attr('href')?.split('/watch/')[1]?.split('?')[0] || null,
                name: $(el).find('.dynamic-name').text().trim() || null,
                jname: $(el).find('.dynamic-name').attr('data-jname') || null,
                time: $(el).find('.time').text().trim() || null,
                episode: $(el).find('.btn').text().trim() || null,
            });
        });
        
        res.json({ success: true, data: { schedule, date: targetDate } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// TOP AIRING
hianime.get('/animes/top-airing', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/top-airing?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// MOST POPULAR
hianime.get('/animes/most-popular', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/most-popular?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// MOST FAVORITE
hianime.get('/animes/most-favorite', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/most-favorite?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// COMPLETED
hianime.get('/animes/completed', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/completed?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// RECENTLY ADDED
hianime.get('/animes/recently-added', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/recently-added?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// RECENTLY UPDATED
hianime.get('/animes/recently-updated', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/recently-updated?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// TOP UPCOMING
hianime.get('/animes/top-upcoming', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/top-upcoming?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// MOVIES
hianime.get('/animes/movie', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/anime-movies?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// TV SERIES
hianime.get('/animes/tv', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/anime-tv?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// SUBBED ANIME
hianime.get('/animes/subbed-anime', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/subbed-anime?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DUBBED ANIME
hianime.get('/animes/dubbed-anime', async (req, res) => {
    const { page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/dubbed-anime?page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        res.json({ success: true, data: { animes, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// AZ LIST
hianime.get('/animes/az-list', async (req, res) => {
    const { letter = 'all', page = 1 } = req.query;
    
    try {
        const result = await fetchWithFallback(`/az-list?letter=${letter}&page=${page}`);
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const animes = [];
        $('.flw-item').each((i, el) => {
            animes.push(parseAnimeItem(el, $));
        });
        
        const letters = [];
        $('.az-list-wrap .letter-list a').each((i, el) => {
            letters.push($(el).text().trim());
        });
        
        res.json({ success: true, data: { animes, letters, letter, page: parseInt(page) } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// FILTER OPTIONS
hianime.get('/filter/options', async (req, res) => {
    try {
        const result = await fetchWithFallback('/filter');
        if (!result) return res.status(500).json({ error: 'Failed to fetch' });
        
        const $ = cheerio.load(result.data);
        
        const types = [];
        $('.filter-group:eq(0) .item').each((i, el) => {
            types.push($(el).text().trim());
        });
        
        const statuses = [];
        $('.filter-group:eq(1) .item').each((i, el) => {
            statuses.push($(el).text().trim());
        });
        
        const genres = [];
        $('.filter-group:eq(2) .item').each((i, el) => {
            genres.push($(el).text().trim());
        });
        
        const years = [];
        $('.filter-group:eq(3) .item').each((i, el) => {
            years.push($(el).text().trim());
        });
        
        res.json({
            success: true,
            data: { types, statuses, genres, years }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// EMBED URL
hianime.get('/embed', async (req, res) => {
    const { id, server = 'hd-1', type = 'sub' } = req.query;
    if (!id) return res.status(400).json({ error: 'Episode ID required' });
    
    const embedUrl = `/ajax/v2/episode/servers?episodeId=${id}`;
    res.json({
        success: true,
        data: {
            url: `${BASE_URLS[0]}${embedUrl}?server=${server}&type=${type}`,
            embedUrl: `${BASE_URLS[0]}/embed/${id}`
        }
    });
});

// PROXY
hianime.get('/proxy', async (req, res) => {
    const { url, referer = 'https://aniwatchtv.to' } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    
    try {
        const decodedUrl = decodeURIComponent(url);
        const response = await axios.get(decodedUrl, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': referer,
            },
            responseType: 'stream'
        });
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        
        response.data.pipe(res);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = hianime;
