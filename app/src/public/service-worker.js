self.addEventListener('install', event => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
    const payload = event.data ? event.data.json() : {};
    const title = payload.title || 'Indian History Bite';
    const options = {
        body: payload.body || 'Your daily history story is ready.',
        icon: 'icons/icon-192x192.png',
        badge: 'icons/icon-192x192.png',
        data: {
            url: payload.url || './'
        }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const targetUrl = event.notification.data && event.notification.data.url ? event.notification.data.url : './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            const matchingClient = clients.find(client => client.url === targetUrl || client.url.endsWith(targetUrl));
            if (matchingClient) {
                return matchingClient.focus();
            }
            return self.clients.openWindow(targetUrl);
        })
    );
});
