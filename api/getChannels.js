const url = require('url');
const { Xtream } = require('@iptv/xtream-api');

// --- HLAVNÍ FUNKCE ---
module.exports = async (req, res) => {
    // Nastavení CORS hlaviček
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { manual_urls = [] } = req.body;
        // Pokud nejsou žádné URL, vrátíme prázdnou odpověď
        if (manual_urls.length === 0) {
            return res.status(200).json({ _metadata: { totalChannels: 0, errors: [], categoriesCount: 0 } });
        }
        
        let allChannels = [];
        let providerErrors = [];

        // Vytvoříme pole "slibů" pro každou URL
        const providerPromises = manual_urls
            .filter(u => u.trim() !== '') // Ignorujeme prázdné řádky
            .map(manualUrl => {
                try {
                    const provider = parseXtreamUrl(manualUrl);
                    // Pro každou URL zavoláme funkci a připojíme vlastní .catch() pro odchycení chyby
                    return getChannelsFromProvider(provider).catch(error => {
                        let errorMessage = error.message;
                        if (error.message.includes('JSON')) {
                            errorMessage = 'Server vrátil neplatná data (může být offline nebo blokován).';
                        }
                        providerErrors.push({ provider: provider.hostname, error: errorMessage, source: 'Manual' });
                        return []; // V případě chyby vrátíme prázdné pole kanálů
                    });
                } catch (error) {
                    providerErrors.push({ provider: manualUrl, error: 'Neplatný formát URL.', source: 'Manual' });
                    return Promise.resolve([]); // Pokud je URL neparsovatelná, vrátíme prázdné pole
                }
            });

        // Počkáme, až se všechny "sliby" dokončí (buď s daty, nebo s prázdným polem po chybě)
        const results = await Promise.all(providerPromises);
        allChannels = results.flat(); // Spojíme všechny výsledky do jednoho pole

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
        res.status(500).json({ error: 'Nastala neočekávaná chyba serveru.', details: error.message });
    }
};

async function getChannelsFromProvider(provider) {
    const xtream = new Xtream({
        url: provider.server,
        username: provider.username,
        password: provider.password,
        http: { timeout: 15000 } // Timeout 15 sekund
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
        provider: { ...provider, isFromAPI: false } // Vše je teď manuální
    }));
}

function processAndMergeChannels(channels) {
    const channelMap = new Map();
    channels.forEach(channel => {
        const normalized = normalizeName(channel.name);
        if (!normalized || !channel.id) return;
        
        const source = {
            id: channel.id,
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
    if (!username || !password) throw new Error("Chybí uživatelské jméno nebo heslo.");
    
    const hostname = parsed.hostname;
    return { server: `${parsed.protocol}//${parsed.host}`, username, password, hostname };
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
