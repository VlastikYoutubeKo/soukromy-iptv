const { Xtream } = require('@iptv/xtream-api');
const { standardizedSerializer } = require('@iptv/xtream-api/standardized');

module.exports = async (req, res) => {
    // Headers for CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle OPTIONS request for CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // Ensure method is POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { channelId, provider } = req.body;
        if (!channelId || !provider || !provider.server || !provider.username || !provider.password) {
            return res.status(400).json({ error: 'Missing channelId or provider info' });
        }

        const xtream = new Xtream({
            url: provider.server,
            username: provider.username,
            password: provider.password,
            serializer: standardizedSerializer,
        });

        const epgData = await xtream.getFullEPG({ channelId });
        res.status(200).json(epgData);

    } catch (error) {
        console.error('EPG fetch error:', error.message);
        // Log more details if available
        if (error.response) {
            console.error('Error response data:', error.response.data);
            console.error('Error response status:', error.response.status);
        }
        res.status(500).json({ error: 'Failed to fetch EPG data.', details: error.message });
    }
};
