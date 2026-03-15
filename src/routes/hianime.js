const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const hianime = express();
const cors = require('cors');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36";
const BASE_URLS = ['https://aniwatchtv.to', 'https://aniwatch.to'];

// Use user's working API
const WORKING_API = 'https://aniwatch-ifaorkapi.vercel.app';

hianime.use(cors());

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

// HOME
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

// SEARCH
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

// SUGGESTION
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

// GENRES
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

// SERVERS
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

// STREAM - with simple flow
hianime.get('/stream', async (req, res) => {
    const { id, server = 'hd-1', type = 'sub' } = req.query;
    if (!id) return res.status(400).json({ error: 'Episode ID required' });
    
    try {
        // Parse IDs
        const episodeMatch = id.match(/ep=(\d+)/);
        const episodeId = episodeMatch ? episodeMatch[1] : id.match(/\d+/)?.[0];
        const animeIdMatch = id.match(/^(.+?)(?:\?ep=)/);
        const animeId = animeIdMatch ? animeIdMatch[1] : id.split('?')[0];
        
        if (!episodeId || !animeId) {
            return res.status(400).json({ error: 'Invalid ID format. Use: anime-id?ep=episode-id' });
        }
        
        // Get servers from aniwatch
        const serversResult = await fetchWithFallback(`/ajax/v2/episode/servers?episodeId=${episodeId}`);
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
        }
        
        if (!selectedServer) {
            return res.status(404).json({ error: 'No servers available' });
        }
        
        // Get stream from working API
        const apiType = type === 'dub' ? 'dub' : 'sub';
        const streamUrl = `${WORKING_API}/api/stream?id=${animeId}?ep=${episodeId}&server=hd-1&type=${apiType}`;
        
        console.log('Calling working API:', streamUrl);
        
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
                console.log('Got m3u8 from working API!');
            }
        } catch (apiErr) {
            console.log('Working API error:', apiErr.message);
            // Fallback to embed
            try {
                const sourceResult = await fetchWithFallback(`/ajax/v2/episode/sources?id=${selectedServer.id}`);
                if (sourceResult) {
                    embedLink = sourceResult.data.link;
                }
            } catch (e) {}
        }
        
        const isEmbed = !m3u8Url;
        
        res.json({
            success: true,
            data: {
                sources: m3u8Url ? [{ url: m3u8Url, type: 'hls' }] : (embedLink ? [{ url: embedLink, type: 'embed' }] : []),
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

// RANDOM
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

// SCHEDULES
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

module.exports = hianime;
