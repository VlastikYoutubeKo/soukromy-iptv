const url = require('url');
const axios = require('axios');
const { Xtream } = require('@iptv/xtream-api');

// --- KONFIGURACE ---
const AMZ_API_BASE_URL = 'https://amz.odjezdy.online/iptv/api';
const AMZ_API_KEY = process.env.AMZ_API_KEY;

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { manual_urls = [] } = req.body;
        let allChannels = [];
        let providerErrors = [];

        // AMZ API
        if (AMZ_API_KEY) {
            try {
                const subscriptions = await getSubscriptionsFromAmz();
                const amzPromises = subscriptions.map(sub => getChannelsFromProvider(sub, true).catch(error => {
                    providerErrors.push({ provider: sub.server, error: error.message, source: 'AMZ API' });
                    return [];
                }));
                const amzResults = await Promise.all(amzPromises);
                allChannels.push(...amzResults.flat());
            } catch (error) {
                providerErrors.push({ provider: 'AMZ API', error: error.message, source: 'AMZ API' });
            }
        }

        // Manuální URL
        if (manual_urls.length > 0) {
            const manualPromises = manual_urls.map(manualUrl => {
                if (!manualUrl.trim()) return Promise.resolve([]);
                try {
                    const provider = parseXtreamUrl(manualUrl);
                    return getChannelsFromProvider(provider, false).catch(error => {
                        providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                        return [];
                    });
                } catch (error) {
                    providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                    return Promise.resolve([]);
                }
            });
            const manualResults = await Promise.all(manualPromises);
            allChannels.push(...manualResults.flat());
        }

        const processedData = processAndMergeChannels(allChannels);
        
        res.status(200).json({
            ...processedData,
            _metadata: {
                totalChannels: allChannels.length,
                errors: providerErrors,
                categoriesCount: Object.keys(processedData).length
            }
        });
        
    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ error: 'Failed to fetch channel data.', details: error.message });
    }
};

async function getChannelsFromProvider(provider, isFromAPI) {
    const xtream = new Xtream({
        url: provider.server,
        username: provider.username,
        password: provider.password,
    });

    const [categories, streams] = await Promise.all([
        xtream.getChannelCategories(),
        xtream.getChannels()
    ]);

    const categoryMap = new Map(categories.map(c => [c.category_id, c.category_name]));

    return streams.map(channel => ({
        id: channel.stream_id.toString(),
        name: channel.name,
        logo: channel.stream_icon || null,
        category_name: categoryMap.get(channel.category_id) || 'Uncategorized',
        provider: { ...provider, hostname: new url.URL(provider.server).hostname, isFromAPI }
    }));
}

async function getSubscriptionsFromAmz() {
    const headers = { 'X-API-Key': AMZ_API_KEY, 'User-Agent': 'IPTV-Portal-Pro/2.0' };
    const { data: subs } = await axios.get(`${AMZ_API_BASE_URL}/subscriptions`, { headers, timeout: 10000 });
    
    const subPromises = subs.map(sub => 
        axios.get(`${AMZ_API_BASE_URL}/subscription/${sub.hash}`, { headers, timeout: 10000 })
             .then(res => res.data)
             .catch(e => {
                 console.warn(`Could not fetch AMZ sub detail for ${sub.hash}: ${e.message}`);
                 return null;
             })
    );
    
    const fullSubscriptions = await Promise.all(subPromises);
    return fullSubscriptions.filter(detail => detail && detail.server && detail.username && detail.password);
}

function processAndMergeChannels(channels) {
    const channelMap = new Map();
    channels.forEach(channel => {
        const normalized = normalizeName(channel.name);
        if (!normalized) return;
        
        const source = {
            id: channel.id,
            url: `${channel.provider.server}/live/${channel.provider.username}/${channel.provider.password}/${channel.id}.ts`,
            provider: channel.provider
        };
        
        if (channelMap.has(normalized)) {
            channelMap.get(normalized).sources.push(source);
        } else {
            channelMap.set(normalized, {
                name: channel.name,
                category: channel.category_name,
                logo: channel.logo,
                sources: [source]
            });
        }
    });

    const categories = {};
    channelMap.forEach(value => {
        const category = value.category || 'Uncategorized';
        if (!categories[category]) categories[category] = [];
        categories[category].push(value);
    });

    const finalStructure = {};
    Object.keys(categories).sort((a,b)=>a.localeCompare(b)).forEach(catName => {
        finalStructure[catName] = categories[catName].sort((a,b) => a.name.localeCompare(b.name));
    });

    return finalStructure;
}

function parseXtreamUrl(inputUrl) {
    const parsed = new url.URL(inputUrl);
    return {
        server: `${parsed.protocol}//${parsed.host}`,
        username: parsed.searchParams.get('username'),
        password: parsed.searchParams.get('password'),
    };
}

function normalizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s*\[.*?\]\s*/g, '')
        .replace(/\b(hd|fhd|uhd|4k|8k|sd|cz|sk)\b/gi, '')
        .replace(/[_\-|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
