const { Xtream } = require('@iptv/xtream-api');
const { standardizedSerializer } = require('@iptv/xtream-api/standardized');
const axios = require('axios');
const globalTunnel = require('global-tunnel-ng');
const url = require('url');

// --- KONFIGURACE A PROXY LOGIKA (zůstává stejná) ---
const AMZ_API_BASE_URL = 'https://amz.odjezdy.online/iptv/api';
const AMZ_API_KEY = process.env.AMZ_API_KEY;
const MAX_RETRIES = 5;
const PROXY_URLS = {
    http: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt',
    socks5: 'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt'
};
let proxyCache = [];
let lastProxyFetch = 0;
const PROXY_CACHE_DURATION = 30 * 60 * 1000;

// --- HLAVNÍ FUNKCE (beze změny) ---
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        await updateProxyCacheIfNeeded();
        const { manual_urls = [] } = req.body;
        let allChannels = [];

        if (AMZ_API_KEY) {
            const subscriptions = await getSubscriptionsFromAmz();
            for (const sub of subscriptions) {
                const channels = await getChannelsWithRetry(sub);
                allChannels.push(...channels);
            }
        }
        for (const manualUrl of manual_urls) {
            if (!manualUrl.trim()) continue;
            try {
                const provider = parseXtreamUrl(manualUrl);
                const channels = await getChannelsWithRetry(provider);
                allChannels.push(...channels);
            } catch (error) { console.warn(`Failed to process manual URL: ${error.message}`); }
        }
        const processedData = processAndMergeChannels(allChannels);
        res.status(200).json(processedData);
    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ error: 'Failed to fetch channel data.', details: error.message });
    }
};

// --- POMOCNÉ FUNKCE ---

// ZÁSADNĚ PŘEPRACOVANÁ FUNKCE
async function getChannelsWithRetry(provider) {
    const { server, username, password } = provider;
    
    // Zkusíme se 5x připojit s různými proxy
    for (let i = 0; i < MAX_RETRIES; i++) {
        const proxy = proxyCache.length > 0 ? proxyCache[Math.floor(Math.random() * proxyCache.length)] : null;
        if (proxy) {
            globalTunnel.initialize({ protocol: proxy.type === 'http' ? 'http:' : 'socks:', host: proxy.host, port: proxy.port });
        }

        try {
            // Krok 1: Získáme kategorie pomocí knihovny (je spolehlivá)
            const xtream = new Xtream({ url: server, username, password, serializer: standardizedSerializer });
            const categories = await xtream.getChannelCategories();
            const categoryMap = new Map(categories.map(c => [c.id, c.name]));
            
            // Krok 2: Získáme kanály pomocí robustnějšího `axios`
            const apiUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
            const response = await axios.get(apiUrl, { timeout: 15000 });

            if (!Array.isArray(response.data)) {
                // Pokud odpověď není pole, server vrátil něco špatně
                throw new Error('Invalid response from server, not an array.');
            }
            
            // Mapování dat je teď potřeba udělat ručně, protože nepoužíváme serializer na kanály
            const channels = response.data.map(channel => ({
                id: channel.stream_id.toString(),
                name: channel.name,
                logo: channel.stream_icon,
                categoryIds: [channel.category_id.toString()],
                url: `${server}/live/${username}/${password}/${channel.stream_id}.ts` // Standardní formát URL
            }));
            
            const channelsWithCategories = channels.map(channel => ({
                ...channel,
                category_name: categoryMap.get(channel.categoryIds[0]) || 'Uncategorized',
                provider: { server, username, password, hostname: new url.URL(server).hostname }
            }));

            if (proxy) globalTunnel.end();
            return channelsWithCategories;

        } catch (error) {
            console.warn(`Attempt ${i + 1}/${MAX_RETRIES} for ${server} failed. Error: ${error.message}`);
            if (proxy) globalTunnel.end();
        }
    }
    
    console.error(`Failed to fetch from ${server} after ${MAX_RETRIES} attempts.`);
    return [];
}


// --- Zbytek souboru zůstává stejný ---
function processAndMergeChannels(channels) {
    const channelMap = new Map();
    channels.forEach(channel => {
        const normalized = normalizeName(channel.name);
        if (!normalized) return;
        const source = { id: channel.id, url: channel.url, provider: channel.provider };
        if (channelMap.has(normalized)) {
            channelMap.get(normalized).sources.push(source);
        } else {
            channelMap.set(normalized, { name: channel.name, category: channel.category_name, logo: channel.logo, sources: [source] });
        }
    });
    const categories = {};
    for (const value of channelMap.values()) {
        if (!categories[value.category]) categories[value.category] = [];
        categories[value.category].push(value);
    }
    const sortedCategories = Object.keys(categories).sort((a, b) => a.localeCompare(b));
    const finalStructure = {};
    sortedCategories.forEach(catName => {
        finalStructure[catName] = categories[catName].sort((a, b) => a.name.localeCompare(b.name));
    });
    return finalStructure;
}
async function updateProxyCacheIfNeeded() { if (Date.now() - lastProxyFetch < PROXY_CACHE_DURATION && proxyCache.length > 0) return; try { const httpResponse = await axios.get(PROXY_URLS.http, { timeout: 5000 }); const socks5Response = await axios.get(PROXY_URLS.socks5, { timeout: 5000 }); const httpProxies = httpResponse.data.split('\n').filter(Boolean).map(p => ({ type: 'http', host: p.split(':')[0], port: p.split(':')[1] })); const socks5Proxies = socks5Response.data.split('\n').filter(Boolean).map(p => ({ type: 'socks5', host: p.split(':')[0], port: p.split(':')[1] })); proxyCache = [...httpProxies, ...socks5Proxies]; lastProxyFetch = Date.now(); } catch (error) { console.error("Failed to fetch proxy lists:", error.message); } }
async function getSubscriptionsFromAmz() { try { const response = await axios.get(`${AMZ_API_BASE_URL}/subscriptions`, { headers: { 'X-API-Key': AMZ_API_KEY } }); const fullSubscriptions = []; for (const sub of response.data) { const detailResponse = await axios.get(`${AMZ_API_BASE_URL}/subscription/${sub.hash}`, { headers: { 'X-API-Key': AMZ_API_KEY } }); const { server, username, password } = detailResponse.data; if (server && username && password) fullSubscriptions.push({ server, username, password }); } return fullSubscriptions; } catch (error) { console.error("Error fetching from AMZ API:", error.message); return []; } }
function parseXtreamUrl(inputUrl) { const parsed = new url.URL(inputUrl); const server = `${parsed.protocol}//${parsed.host}`; const username = parsed.searchParams.get('username'); const password = parsed.searchParams.get('password'); if (!server || !username || password === null) throw new Error('Invalid URL'); return { server, username, password }; }
function normalizeName(name) { return name.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/\s*\[.*?\]\s*/g, '').replace(/hd|fhd|uhd|4k|8k|sd/g, '').replace(/[\s\-_|]+/g, '').trim(); }
