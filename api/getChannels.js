const url = require('url');
const { Xtream } = require('@iptv/xtream-api');

// --- KONFIGURACE ---
const AMZ_API_BASE_URL = 'https://amz.odjezdy.online/iptv/api';
const AMZ_API_KEY = process.env.AMZ_API_KEY;

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

        // Načteme AMZ API zdroje, pokud je k dispozici klíč
        if (AMZ_API_KEY) {
            try {
                const subscriptions = await getSubscriptionsFromAmz();
                console.log(`Found ${subscriptions.length} AMZ subscriptions`);
                const amzPromises = subscriptions.map(sub => 
                    getChannelsFromProvider(sub, true).catch(error => {
                        providerErrors.push({ provider: sub.server, error: error.message, source: 'AMZ API' });
                        return []; // V případě chyby vrátíme prázdné pole
                    })
                );
                const amzResults = await Promise.all(amzPromises);
                allChannels.push(...amzResults.flat());
            } catch (error) {
                console.warn(`AMZ API error: ${error.message}`);
                providerErrors.push({ provider: 'AMZ API', error: error.message, source: 'AMZ API' });
            }
        }

        // Načteme manuální URLs
        if (manual_urls.length > 0) {
            const manualPromises = manual_urls.map(manualUrl => {
                if (!manualUrl.trim()) return [];
                try {
                    const provider = parseXtreamUrl(manualUrl);
                    return getChannelsFromProvider(provider, false).catch(error => {
                        providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                        return [];
                    });
                } catch (error) {
                    providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                    return [];
                }
            });
            const manualResults = await Promise.all(manualPromises);
            allChannels.push(...manualResults.flat());
        }

        const processedData = processAndMergeChannels(allChannels);
        
        const response = {
            ...processedData,
            _metadata: {
                totalChannels: allChannels.length,
                errors: providerErrors,
                categoriesCount: Object.keys(processedData).length
            }
        };

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(200).json(response);
        
    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ error: 'Failed to fetch channel data.', details: error.message });
    }
};

// --- POMOCNÉ FUNKCE ---

async function getChannelsFromProvider(provider, isFromAPI) {
    console.log(`Fetching channels from: ${provider.server}`);
    const xtream = new Xtream({
        url: provider.server,
        username: provider.username,
        password: provider.password,
    });

    const [categories, streams] = await Promise.all([
        xtream.getLiveCategories(),
        xtream.getLiveStreams()
    ]);

    const categoryMap = new Map(categories.map(c => [c.category_id, c.category_name]));

    return streams.map(channel => ({
        id: channel.stream_id.toString(),
        name: channel.name,
        logo: channel.stream_icon || null,
        category_name: categoryMap.get(channel.category_id) || 'Uncategorized',
        provider: {
            ...provider,
            hostname: new url.URL(provider.server).hostname,
            isFromAPI
        }
    }));
}

async function getSubscriptionsFromAmz() {
    // Tato funkce zůstává stejná, protože používá specifické API, nikoliv Xtream
    // ... (kód z předchozí verze getChannels.js)
    const fetch = require('node-fetch'); // axios nahrazen za node-fetch pro jednoduchost
    const headers = { 'X-API-Key': AMZ_API_KEY };
    const response = await fetch(`${AMZ_API_BASE_URL}/subscriptions`, { headers });
    if (!response.ok) throw new Error(`AMZ API responded with ${response.status}`);
    const subs = await response.json();
    
    const fullSubscriptions = [];
    for (const sub of subs) {
        try {
            const detailResponse = await fetch(`${AMZ_API_BASE_URL}/subscription/${sub.hash}`, { headers });
            const detail = await detailResponse.json();
            if (detail.server && detail.username && detail.password) {
                fullSubscriptions.push(detail);
            }
        } catch (e) { console.warn(`Could not fetch AMZ sub detail for ${sub.hash}`); }
    }
    return fullSubscriptions;
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
    for (const value of channelMap.values()) {
        if (!categories[value.category]) categories[value.category] = [];
        categories[value.category].push(value);
    }
    
    // Seřadíme kategorie i kanály v nich
    const finalStructure = {};
    Object.keys(categories).sort((a,b)=>a.localeCompare(b)).forEach(catName => {
        finalStructure[catName] = categories[catName].sort((a,b) => a.name.localeCompare(b.name));
    });

    return finalStructure;
}


function parseXtreamUrl(inputUrl) {
    const parsed = new url.URL(inputUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');
    if (!server || !username || !password) {
        throw new Error(`Invalid M3U_PLUS URL: ${inputUrl}`);
    }
    return { server, username, password };
}

function normalizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s*\[.*?\]\s*/g, '')
        .replace(/\b(hd|fhd|uhd|4k|8k|sd|cz|sk)\b/gi, '')
        .replace(/[\s\-_|]+/g, '')
        .trim();
}
