self.addEventListener('notificationclick', event => {
    event.notification.close();

    const basePath = new URL(self.registration.scope).pathname.replace(/\/$/, '');
    const targetUrl = (() => {
        try {
            const requestedUrl = event.notification.data && event.notification.data.url;
            return new URL(requestedUrl || `${basePath}/`, self.location.origin).href;
        } catch (_) {
            return new URL(`${basePath}/`, self.location.origin).href;
        }
    })();

    event.waitUntil((async () => {
        const windowClients = await clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        });

        for (const client of windowClients) {
            if ('focus' in client) {
                const clientUrl = new URL(client.url);
                if (clientUrl.href === targetUrl) {
                    await client.focus();
                    return;
                }

                if (clientUrl.pathname.startsWith(basePath) && 'navigate' in client) {
                    await client.navigate(targetUrl);
                    await client.focus();
                    return;
                }
            }
        }

        if (clients.openWindow) {
            await clients.openWindow(targetUrl);
        }
    })());
});
