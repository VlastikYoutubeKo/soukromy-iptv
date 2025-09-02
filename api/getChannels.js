const url = require('url');
const { Xtream } = require('@iptv/xtream-api');

// --- HLAVNÍ FUNKCE ---
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { manual_urls = [] } = req.body;
        if (manual_urls.length === 0) {
            return res.status(200).json({ _metadata: { totalChannels: 0, errors: [], categoriesCount: 0 } });
        }
        
        let allChannels = [];
        let providerErrors = [];

        // Zpracujeme manuální URLs
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
            // Zachytíme chyby z jednotlivých providerů, aby ostatní mohli pokračovat
            providerErrors.push({ provider: e.config?.url || 'Manual URL', error: e.message, source: 'Manual' });
            return [];
        })));
        
        allChannels.push(...manualResults.flat());

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
        // Zvýšíme timeout pro pomalejší servery
        http: { timeout: 20000 } 
    });

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
