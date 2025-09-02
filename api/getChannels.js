const url = require('url');
const axios = require('axios');
const { Xtream } = require('@iptv/xtream-api');

// --- KONFIGURACE ---
const AMZ_API_BASE_URL = 'https://amz.odjezdy.online/iptv/api';
const API_KEYS = process.env.AMZ_API_KEY ? process.env.AMZ_API_KEY.split(',').map(k => k.trim()).filter(Boolean) : [];

// --- HLAVNÍ FUNKCE ---
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

        // Načteme AMZ API zdroje pro každý klíč
        if (API_KEYS.length > 0) {
            console.log(`Processing ${API_KEYS.length} AMZ API key(s).`);
            const keyPromises = API_KEYS.map(apiKey => 
                getSubscriptionsFromAmz(apiKey)
                    .then(subscriptions => {
                        const channelPromises = subscriptions.map(sub => getChannelsFromProvider(sub, true).catch(e => {
                            providerErrors.push({ provider: sub.server, error: e.message, source: 'AMZ API' });
                            return [];
                        }));
                        return Promise.all(channelPromises);
                    })
                    .catch(error => {
                        providerErrors.push({ provider: `AMZ API Key (${apiKey.substring(0, 4)}...)`, error: error.message, source: 'AMZ API' });
                        return [];
                    })
            );
            
            const results = await Promise.all(keyPromises);
            allChannels.push(...results.flat(2));
        }

        // Načteme manuální URLs
        if (manual_urls.length > 0) {
            const manualPromises = manual_urls.map(manualUrl => {
                if (!manualUrl.trim()) return Promise.resolve([]);
                try {
                    const provider = parseXtreamUrl(manualUrl);
                    return getChannelsFromProvider(provider, false);
                } catch (error) {
                    providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                    return Promise.resolve([]);
                }
            });
            const manualResults = await Promise.all(manualPromises.map(p => p.catch(e => {
                 providerErrors.push({ provider: 'Manual URL processing', error: e.message, source: 'Manual' });
                 return [];
            })));
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

async function getSubscriptionsFromAmz(apiKey) {
    const headers = { 'X-API-Key': apiKey, 'User-Agent': 'IPTV-Portal-Pro/2.2' };
    const { data: subs } = await axios.get(`${AMZ_API_BASE_URL}/subscriptions`, { headers, timeout: 15000 });
    
    const subPromises = subs.map(sub => 
        axios.get(`${AMZ_API_BASE_URL}/subscription/${sub.hash}`, { headers, timeout: 15000 })
             .then(res => res.data)
             .catch(e => {
                 console.warn(`Could not fetch AMZ sub detail for ${sub.hash}: ${e.message}`);
                 return null;
             })
    );
    
    const fullSubscriptions = await Promise.all(subPromises);
    return fullSubscriptions.filter(detail => detail && detail.server && detail.username && detail.password);
}

async function getChannelsFromProvider(provider, isFromAPI) {
    const xtream = new Xtream({
        url: provider.server,
        username: provider.username,
        password: provider.password,
    });

    // Získáme všechny kanály (knihovna si sama řeší stránkování)
    const [categories, streams] = await Promise.all([
        xtream.getChannelCategories(),
        xtream.getChannels({ limit: Infinity }) 
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

function processAndMergeChannels(channels) {
    const channelMap = new Map();
    channels.forEach(channel => {
        const normalized = normalizeName(channel.name);
        if (!normalized || !channel.id) return;
        
        const source = {
            id: channel.id,
            url: `${channel.provider.server}/live/${channel.provider.username}/${channel.provider.password}/${channel.id}.ts`,
            provider: channel.provider
        };
        
        if (channelMap.has(normalized)) {
            const existing = channelMap.get(normalized);
            // Přidáme zdroj jen pokud je od jiného poskytovatele
            if (!existing.sources.some(s => s.provider.server === source.provider.server)) {
                existing.sources.push(source);
            }
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
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');
    if (!username || !password) throw new Error("Missing username or password.");
    return { server: `${parsed.protocol}//${parsed.host}`, username, password };
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
