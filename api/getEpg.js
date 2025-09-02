const { Xtream } = require('@iptv/xtream-api');

module.exports = async (req, res) => {
    // CORS hlavičky
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { channelId, provider } = req.body;
        if (!channelId || !provider) {
            return res.status(400).json({ error: 'Chybí channelId nebo informace o poskytovateli' });
        }
        
        const xtream = new Xtream({
            url: provider.server,
            username: provider.username,
            password: provider.password,
            http: { timeout: 15000 } // Zvýšený timeout
        });
        
        const epgData = await xtream.getFullEPG({ channelId });
        
        // *** ZDE JE KLÍČOVÁ ZMĚNA ***
        // Logování surové odpovědi na straně serveru pro snadnější ladění
        console.log(`[EPG LOG] Odpověď pro kanál ${channelId} od ${provider.hostname}:`, JSON.stringify(epgData, null, 2));

        res.status(200).json(epgData);

    } catch (error) {
        // Logování chyby na straně serveru
        console.error(`[EPG ERROR] Chyba při načítání EPG pro kanál ${req.body.channelId} od ${req.body.provider?.hostname}:`, error.message);
        
        res.status(500).json({ 
            error: 'Nepodařilo se načíst EPG data.', 
            details: error.message 
        });
    }
};
