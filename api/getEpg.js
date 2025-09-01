const { Xtream } = require('@iptv/xtream-api');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { channelId, provider } = req.body;
        if (!channelId || !provider) {
            return res.status(400).json({ error: 'Missing channelId or provider info' });
        }
        
        // Inicializace Xtream bez explicitního serializéru
        const xtream = new Xtream({
            url: provider.server,
            username: provider.username,
            password: provider.password
        });
        
        const epgData = await xtream.getFullEPG({ channelId });
        res.status(200).json(epgData);
    } catch (error) {
        console.error('EPG fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch EPG data.', details: error.message });
    }
};
