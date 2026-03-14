const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const genre = require('./routes/genre.js');
const info = require('./routes/info.js');
const app = require('./routes/app.js');
const search = require('./routes/search.js');
const random = require('./routes/random.js');
const mix = require('./routes/mix.js');
const episode = require('./routes/episode.js');
const shedule = require('./routes/shedule.js');
const server = require('./routes/server.js');
const src = require('./routes/src1.js');
const sources = require('./routes/sources.js');

const inde = express();

try {
    inde.use('/api', genre);
    inde.use('/api', info);
    inde.use('/api', app);
    inde.use('/api', search);
    inde.use('/api', random);
    inde.use('/api', mix);
    inde.use('/api', episode);
    inde.use('/api', shedule);
    inde.use('/api', server);
    inde.use('/api', src);
    inde.use('/api/sources', sources);

    inde.get('/', (req, res) =>{
        res.send("Api Is ON SERVICE !");
    });

} catch (error) {
    console.log(error);
}

// Vercel serverless export
module.exports = inde;
