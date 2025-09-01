document.addEventListener('DOMContentLoaded', () => {
    const loadChannelsBtn = document.getElementById('loadChannelsBtn');
    const manualUrlsInput = document.getElementById('manualUrls');
    const channelListDiv = document.getElementById('channelList');
    const loader = document.getElementById('loader');
    const showInfoBtn = document.getElementById('showInfoBtn');

    // Modals
    const epgModal = document.getElementById('epgModal');
    const infoModal = document.getElementById('infoModal');

    let channelsData = {};
    let providers = [];

    // Event listeners
    loadChannelsBtn.addEventListener('click', fetchAndDisplayChannels);
    showInfoBtn.addEventListener('click', fetchAndDisplayInfo);

    // Univerzální zavírání pro všechny modaly
    document.querySelectorAll('.modal .close-button').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.closest('.modal').style.display = 'none';
        });
    });
    window.addEventListener('click', (event) => {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    });

    async function fetchAndDisplayChannels() {
        loader.style.display = 'block';
        channelListDiv.innerHTML = '';
        showInfoBtn.disabled = true;
        const manualUrls = manualUrlsInput.value.split('\n').filter(url => url.trim() !== '');
        try {
            const response = await fetch('/api/getChannels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ manual_urls: manualUrls }),
            });
            if (!response.ok) throw new Error((await response.json()).error);
            channelsData = await response.json();
            
            // Extrahujeme unikátní providery
            const uniqueProviders = new Map();
            Object.values(channelsData).flat().forEach(channel => {
                channel.sources.forEach(source => {
                    uniqueProviders.set(source.provider.server, source.provider);
                });
            });
            providers = Array.from(uniqueProviders.values());
            
            displayChannels(channelsData);
            if (providers.length > 0) {
                showInfoBtn.disabled = false;
            }
        } catch (error) {
            channelListDiv.innerHTML = `<p style="color: red;">Chyba: ${error.message}</p>`;
        } finally {
            loader.style.display = 'none';
        }
    }

    function displayChannels(categories) {
        // ... kód pro zobrazení kanálů (beze změny)
        if (Object.keys(categories).length === 0) { channelListDiv.innerHTML = '<p>Nebyly nalezeny žádné kanály.</p>'; return; }
        let html = '';
        for (const categoryName in categories) {
            html += `<div class="category"><h2>${categoryName}</h2><div class="channel-grid">`;
            categories[categoryName].forEach((channel, index) => {
                const logo = channel.logo || 'https://via.placeholder.com/100?text=No+Logo';
                html += `<div class="channel" data-category="${categoryName}" data-index="${index}"><img src="${logo}" alt="${channel.name}" class="channel-logo" onerror="this.src='https://via.placeholder.com/100?text=No+Logo';"><div class="channel-name">${channel.name}</div><div class="source-count">${channel.sources.length} ${channel.sources.length === 1 ? 'zdroj' : (channel.sources.length < 5 ? 'zdroje' : 'zdrojů')}</div></div>`;
            });
            html += `</div></div>`;
        }
        channelListDiv.innerHTML = html;
    }

    // EPG Logika (beze změny)
    channelListDiv.addEventListener('click', async (event) => {
        const channelEl = event.target.closest('.channel');
        if (!channelEl) return;
        const category = channelEl.dataset.category;
        const index = channelEl.dataset.index;
        const channel = channelsData[category][index];
        const epgChannelName = document.getElementById('epgChannelName');
        const epgList = document.getElementById('epgList');

        epgChannelName.textContent = channel.name;
        epgList.innerHTML = '<div class="loader"></div>';
        epgModal.style.display = 'block';

        const source = channel.sources[0];
        try {
            const response = await fetch('/api/getEpg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: source.id, provider: source.provider }) });
            if (!response.ok) throw new Error((await response.json()).error);
            const epgData = await response.json();
            displayEpg(epgData);
        } catch (error) { epgList.innerHTML = `<p style="color: orange;">EPG se nepodařilo načíst: ${error.message}</p>`; }
    });
    function displayEpg(epgData) {
        const epgList = document.getElementById('epgList');
        if (!epgData || epgData.length === 0) { epgList.innerHTML = '<p>Pro tento kanál není k dispozici žádný program.</p>'; return; }
        let html = '';
        const now = new Date();
        epgData.forEach(program => {
            const start = new Date(program.start); const end = new Date(program.end);
            const isNowPlaying = start <= now && end > now;
            const timeFormat = { hour: '2-digit', minute: '2-digit' };
            html += `<div class="epg-item" style="${isNowPlaying ? 'background-color: #018786;' : ''}"><div class="epg-time">${start.toLocaleTimeString([], timeFormat)} - ${end.toLocaleTimeString([], timeFormat)}</div><div class="epg-title">${program.title}</div>${program.description ? `<div class="epg-desc">${program.description}</div>` : ''}</div>`;
        });
        epgList.innerHTML = html;
    }

    // NOVÁ LOGIKA PRO INFO MODAL
    async function fetchAndDisplayInfo() {
        const infoList = document.getElementById('infoList');
        infoList.innerHTML = '<div class="loader"></div>';
        infoModal.style.display = 'block';

        let html = '';
        for (const provider of providers) {
            try {
                const response = await fetch('/api/getInfo', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider }),
                });
                if (!response.ok) throw new Error((await response.json()).error);
                const { profile, serverInfo } = await response.json();
                html += generateInfoCard(profile, serverInfo);
            } catch (error) {
                html += generateInfoCardError(provider, error.message);
            }
        }
        infoList.innerHTML = html;
    }

    function generateInfoCard(profile, serverInfo) {
        const expires = profile.expiresAt ? new Date(profile.expiresAt).toLocaleString() : 'N/A';
        return `
            <div class="info-card">
                <h3>${profile.username} @ ${serverInfo.url}</h3>
                <div class="info-grid">
                    <strong>Stav:</strong> <span>${profile.status}</span>
                    <strong>Vyprší:</strong> <span>${expires}</span>
                    <strong>Připojení:</strong> <span>${profile.activeConnections} / ${profile.maxConnections}</span>
                    <strong>Verze serveru:</strong> <span>${serverInfo.version} (${serverInfo.timezone})</span>
                </div>
            </div>
        `;
    }

    function generateInfoCardError(provider, error) {
        return `
            <div class="info-card">
                <h3>${provider.username} @ ${provider.hostname}</h3>
                <p style="color: orange;">Informace se nepodařilo načíst: ${error}</p>
            </div>
        `;
    }
});
