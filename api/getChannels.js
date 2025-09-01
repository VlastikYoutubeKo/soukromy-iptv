const axios = require('axios');
const url = require('url');

// --- KONFIGURACE ---
const AMZ_API_BASE_URL = 'https://amz.odjezdy.online/iptv/api';
const AMZ_API_KEY = process.env.AMZ_API_KEY;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 15000;

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

        // Načteme AMZ API zdroje
        if (AMZ_API_KEY) {
            try {
                const subscriptions = await getSubscriptionsFromAmz();
                console.log(`Found ${subscriptions.length} AMZ subscriptions`);
                
                for (const sub of subscriptions) {
                    try {
                        const channels = await getChannelsWithRetry(sub, true);
                        allChannels.push(...channels);
                        console.log(`Successfully loaded ${channels.length} channels from AMZ: ${sub.server}`);
                    } catch (error) {
                        providerErrors.push({ provider: sub.server, error: error.message, source: 'AMZ API' });
                        console.warn(`Failed to load channels from AMZ provider ${sub.server}: ${error.message}`);
                    }
                }
            } catch (error) {
                console.warn(`AMZ API error: ${error.message}`);
                providerErrors.push({ provider: 'AMZ API', error: error.message, source: 'AMZ API' });
            }
        }

        // Načteme manuální URLs
        for (const manualUrl of manual_urls) {
            if (!manualUrl.trim()) continue;
            try {
                const provider = parseXtreamUrl(manualUrl);
                console.log(`Processing manual URL: ${provider.server}`);
                const channels = await getChannelsWithRetry(provider, false);
                allChannels.push(...channels);
                console.log(`Successfully loaded ${channels.length} channels from manual: ${provider.server}`);
            } catch (error) {
                providerErrors.push({ provider: manualUrl, error: error.message, source: 'Manual' });
                console.warn(`Failed to process manual URL ${manualUrl}: ${error.message}`);
            }
        }

        const processedData = processAndMergeChannels(allChannels);
        
        // Přidáme informace o chybách do odpovědi (pro debug)
        const response = {
            channels: processedData,
            totalChannels: allChannels.length,
            errors: providerErrors
        };

        console.log(`Total channels loaded: ${allChannels.length}`);
        res.status(200).json(response);
        
    } catch (error) {
        console.error('General error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch channel data.', 
            details: error.message,
            channels: {},
            errors: []
        });
    }
};

// --- POMOCNÉ FUNKCE ---

async function getChannelsWithRetry(provider, isFromAPI = false) {
    const { server, username, password } = provider;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`Attempt ${attempt}/${MAX_RETRIES} for ${server}`);
            
            // Nejdříve zkusíme získat kategorie
            let categoryMap = new Map();
            try {
                const categoriesUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_categories`;
                const categoriesResponse = await axios.get(categoriesUrl, { 
                    timeout: REQUEST_TIMEOUT,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                if (Array.isArray(categoriesResponse.data)) {
                    categoryMap = new Map(categoriesResponse.data.map(c => [c.category_id?.toString(), c.category_name || 'Uncategorized']));
                }
                console.log(`Loaded ${categoryMap.size} categories for ${server}`);
            } catch (catError) {
                console.warn(`Failed to load categories for ${server}: ${catError.message}`);
            }

            // Získáme seznam kanálů
            const apiUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
            console.log(`Fetching channels from: ${apiUrl}`);
            
            const response = await axios.get(apiUrl, { 
                timeout: REQUEST_TIMEOUT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.data || !Array.isArray(response.data)) {
                throw new Error('Invalid response from server - expected array of channels');
            }
            
            if (response.data.length === 0) {
                console.warn(`No channels found for ${server}`);
                return [];
            }

            console.log(`Found ${response.data.length} channels from ${server}`);
            
            const channels = response.data
                .filter(channel => channel.stream_id && channel.name) // Filter out invalid channels
                .map(channel => ({
                    id: channel.stream_id.toString(),
                    name: channel.name,
                    logo: channel.stream_icon || null,
                    categoryIds: [channel.category_id?.toString() || 'unknown'],
                    url: `${server}/live/${username}/${password}/${channel.stream_id}.ts`,
                    category_name: categoryMap.get(channel.category_id?.toString()) || 'Uncategorized',
                    provider: { 
                        server, 
                        username, 
                        password, 
                        hostname: new url.URL(server).hostname,
                        isFromAPI 
                    }
                }));

            console.log(`Successfully processed ${channels.length} valid channels from ${server}`);
            return channels;

        } catch (error) {
            console.warn(`Attempt ${attempt}/${MAX_RETRIES} for ${server} failed: ${error.message}`);
            
            if (attempt === MAX_RETRIES) {
                throw new Error(`Failed after ${MAX_RETRIES} attempts: ${error.message}`);
            }
            
            // Krátká pauza před dalším pokusem
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

async function getSubscriptionsFromAmz() {
    try {
        const headers = {
            'X-API-Key': AMZ_API_KEY,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
        };
        
        console.log('Fetching subscriptions from AMZ API...');
        const response = await axios.get(`${AMZ_API_BASE_URL}/subscriptions`, { 
            headers,
            timeout: 10000
        });
        
        if (!Array.isArray(response.data)) {
            throw new Error('Invalid response from AMZ API - expected array');
        }

        const fullSubscriptions = [];
        console.log(`Processing ${response.data.length} subscriptions from AMZ API...`);
        
        for (const sub of response.data) {
            try {
                const detailResponse = await axios.get(`${AMZ_API_BASE_URL}/subscription/${sub.hash}`, { 
                    headers,
                    timeout: 10000
                });
                
                const { server, username, password } = detailResponse.data;
                if (server && username && password) {
                    fullSubscriptions.push({ server, username, password });
                    console.log(`Added AMZ subscription: ${server} (${username})`);
                } else {
                    console.warn(`Incomplete subscription data for hash: ${sub.hash}`);
                }
            } catch (detailError) {
                console.warn(`Failed to get details for subscription ${sub.hash}: ${detailError.message}`);
            }
        }
        
        return fullSubscriptions;
    } catch (error) {
        console.error("Error fetching from AMZ API:", error.message);
        if (error.response) {
            console.error("AMZ API Response Status:", error.response.status);
            console.error("AMZ API Response Data:", error.response.data);
        }
        throw error;
    }
}

function processAndMergeChannels(channels) {
    const channelMap = new Map();
    let processedCount = 0;
    
    channels.forEach(channel => {
        const normalized = normalizeName(channel.name);
        if (!normalized) return;
        
        processedCount++;
        const source = { 
            id: channel.id, 
            url: channel.url, 
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
    for (const value of channelMap.values()) {
        if (!categories[value.category]) categories[value.category] = [];
        categories[value.category].push(value);
    }

    const sortedCategories = Object.keys(categories).sort((a, b) => a.localeCompare(b));
    const finalStructure = {};
    sortedCategories.forEach(catName => {
        finalStructure[catName] = categories[catName].sort((a, b) => a.name.localeCompare(b.name));
    });

    console.log(`Processed ${processedCount} channels into ${Object.keys(finalStructure).length} categories`);
    return finalStructure;
}

// OPRAVENÁ FUNKCE PRO PARSING M3U_PLUS ODKAZŮ
function parseXtreamUrl(inputUrl) { 
    try {
        const parsed = new url.URL(inputUrl);
        
        // Pokud je to M3U_PLUS odkaz (obsahuje get.php)
        if (parsed.pathname.includes('get.php')) {
            const server = `${parsed.protocol}//${parsed.host}`;
            const username = parsed.searchParams.get('username');
            const password = parsed.searchParams.get('password');
            
            if (!server || !username || !password) {
                throw new Error(`Missing required parameters in M3U_PLUS URL: ${inputUrl}`);
            }
            
            console.log(`Parsed M3U_PLUS URL - Server: ${server}, Username: ${username}`);
            return { server, username, password };
        }
        
        // Původní logika pro běžné Xtream odkazy
        const server = `${parsed.protocol}//${parsed.host}`;
        const username = parsed.searchParams.get('username');
        const password = parsed.searchParams.get('password');
        
        if (!server || !username || password === null) {
            throw new Error(`Invalid Xtream URL format: ${inputUrl}`);
        }
        
        return { server, username, password };
    } catch (error) {
        throw new Error(`Failed to parse URL "${inputUrl}": ${error.message}`);
    }
}

function normalizeName(name) { 
    if (!name || typeof name !== 'string') return '';
    return name.toLowerCase()
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/\s*\[.*?\]\s*/g, '')
        .replace(/\b(hd|fhd|uhd|4k|8k|sd)\b/gi, '')
        .replace(/[\s\-_|]+/g, '')
        .trim(); 
}
