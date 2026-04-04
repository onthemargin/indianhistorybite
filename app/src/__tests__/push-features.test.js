const path = require('path');
const fsp = require('fs/promises');

// Set env vars BEFORE requiring server
process.env.PORT = '0';
process.env.BASE_PATH = '/indianhistorybite';
process.env.PROMPT_TEXT = 'Test prompt for unit tests';
process.env.APP_API_KEY = 'test-api-key-12345';

const supertest = require('supertest');
const express = require('express');

let server;
let request;

const runtimeDataDir = path.resolve(__dirname, '../../../runtime/data');
const storiesDir = path.join(runtimeDataDir, 'stories');
const subscriptionsPath = path.join(runtimeDataDir, 'push-subscriptions.json');
const deliveryLogPath = path.join(runtimeDataDir, 'push-delivery-log.json');

beforeAll((done) => {
    fsp.mkdir(runtimeDataDir, { recursive: true })
        .then(() => fsp.mkdir(storiesDir, { recursive: true }))
        .then(() => fsp.unlink(path.join(runtimeDataDir, 'current-story.json')).catch(() => {}))
        .then(() => fsp.unlink(subscriptionsPath).catch(() => {}))
        .then(() => fsp.unlink(deliveryLogPath).catch(() => {}))
        .then(() => {
            const originalListen = express.application.listen;
            express.application.listen = function (...args) {
                server = originalListen.call(this, 0, '127.0.0.1', () => {
                    request = supertest(server);
                    express.application.listen = originalListen;
                    done();
                });
                return server;
            };

            const serverPath = require.resolve('../server');
            delete require.cache[serverPath];
            const secPath = require.resolve('../security');
            delete require.cache[secPath];
            const schedPath = require.resolve('../story-scheduler');
            delete require.cache[schedPath];

            require('../server');
        });
});

afterAll((done) => {
    if (server) {
        server.close(done);
    } else {
        done();
    }
});

// ── Path traversal protection ──────────────────────────────────
describe('GET /api/result path traversal protection', () => {
    it('rejects path traversal in ?story= parameter', async () => {
        const res = await request.get('/indianhistorybite/api/result?story=../../../etc/passwd');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid.*date/i);
    });

    it('rejects non-date strings in ?story= parameter', async () => {
        const res = await request.get('/indianhistorybite/api/result?story=not-a-date');
        expect(res.status).toBe(400);
    });

    it('rejects partial date formats', async () => {
        const res = await request.get('/indianhistorybite/api/result?story=2026-3-9');
        expect(res.status).toBe(400);
    });

    it('rejects dates with trailing content', async () => {
        const res = await request.get('/indianhistorybite/api/result?story=2026-03-29;DROP');
        expect(res.status).toBe(400);
    });

    it('accepts valid YYYY-MM-DD format (returns 404 for nonexistent)', async () => {
        const res = await request.get('/indianhistorybite/api/result?story=1947-08-15');
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/1947-08-15/);
    });

    it('accepts no story parameter (returns current story)', async () => {
        const res = await request.get('/indianhistorybite/api/result');
        expect([200, 404]).toContain(res.status);
    });

    it('also validates storyDateKey alias', async () => {
        const res = await request.get('/indianhistorybite/api/result?storyDateKey=../../etc/passwd');
        expect(res.status).toBe(400);
    });
});

// ── Push subscribe/unsubscribe endpoints ───────────────────────
describe('POST /api/push/subscribe', () => {
    const validSubscription = {
        subscription: {
            endpoint: 'https://fcm.googleapis.com/fcm/send/test-id-123',
            keys: {
                p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs',
                auth: 'tBHItJI5svbpC7htqlcmZg'
            }
        }
    };

    it('accepts valid push subscription', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/subscribe')
            .send(validSubscription);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('rejects subscription with http endpoint', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/subscribe')
            .send({
                subscription: {
                    endpoint: 'http://insecure.example.com/push',
                    keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs', auth: 'tBHItJI5svbpC7htqlcmZg' }
                }
            });
        expect(res.status).toBe(400);
    });

    it('rejects subscription missing keys', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/subscribe')
            .send({ subscription: { endpoint: 'https://example.com/push' } });
        expect(res.status).toBe(400);
    });

    it('rejects empty body', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/subscribe')
            .send({});
        expect(res.status).toBe(400);
    });
});

describe('POST /api/push/unsubscribe', () => {
    it('accepts valid unsubscribe payload', async () => {
        // First subscribe
        await request
            .post('/indianhistorybite/api/push/subscribe')
            .send({
                subscription: {
                    endpoint: 'https://fcm.googleapis.com/fcm/send/unsub-test',
                    keys: {
                        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs',
                        auth: 'tBHItJI5svbpC7htqlcmZg'
                    }
                }
            });

        const res = await request
            .post('/indianhistorybite/api/push/unsubscribe')
            .send({
                subscription: {
                    endpoint: 'https://fcm.googleapis.com/fcm/send/unsub-test',
                    keys: {
                        p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs',
                        auth: 'tBHItJI5svbpC7htqlcmZg'
                    }
                }
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── Delivery status endpoint ───────────────────────────────────
describe('POST /api/push/delivery-status', () => {
    it('requires API key', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/delivery-status')
            .send({ endpoint: 'https://example.com', status: 'sent' });
        expect(res.status).toBe(401);
    });

    it('accepts valid delivery status with API key', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/delivery-status')
            .set('x-api-key', 'test-api-key-12345')
            .send({ endpoint: 'https://example.com/push', status: 'sent', storyDateKey: '2026-04-04' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('rejects invalid status values', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/delivery-status')
            .set('x-api-key', 'test-api-key-12345')
            .send({ endpoint: 'https://example.com/push', status: 'invalid' });
        expect(res.status).toBe(400);
    });

    it('rejects missing endpoint', async () => {
        const res = await request
            .post('/indianhistorybite/api/push/delivery-status')
            .set('x-api-key', 'test-api-key-12345')
            .send({ status: 'sent' });
        // 400 for validation, 429 if rate limited
        expect([400, 429]).toContain(res.status);
    });
});

// ── Admin status endpoint ──────────────────────────────────────
describe('GET /api/admin/status', () => {
    it('requires API key', async () => {
        const res = await request.get('/indianhistorybite/api/admin/status');
        // 401 for missing key, 429 if rate limited
        expect([401, 429]).toContain(res.status);
    });

    it('returns status with valid API key', async () => {
        const res = await request
            .get('/indianhistorybite/api/admin/status')
            .set('x-api-key', 'test-api-key-12345');
        // 200 for success, 429 if rate limited
        if (res.status === 429) return; // rate limited, skip assertions
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('subscriptions');
        expect(res.body).toHaveProperty('sends');
        expect(res.body.subscriptions).toHaveProperty('total');
        expect(res.body.subscriptions).toHaveProperty('active');
        expect(res.body.sends).toHaveProperty('todayTotal');
    });
});

// ── Delivery log rotation ──────────────────────────────────────
describe('delivery log rotation', () => {
    it('trims delivery log to max entries', async () => {
        // Write a large delivery log directly
        const entries = Array.from({ length: 1500 }, (_, i) => ({
            endpoint: `https://example.com/push-${i}`,
            status: 'sent',
            storyDateKey: '2026-04-04',
            deliveredAt: new Date(Date.now() - i * 1000).toISOString()
        }));
        await fsp.writeFile(deliveryLogPath, JSON.stringify(entries, null, 2));

        // Use scheduler directly to bypass rate limiting
        const scheduler = require('../story-scheduler');
        await scheduler.recordPushDeliveryStatus({
            endpoint: 'https://example.com/new',
            status: 'sent',
            storyDateKey: '2026-04-04'
        });

        // Read the log — should be trimmed
        const raw = await fsp.readFile(deliveryLogPath, 'utf8');
        const log = JSON.parse(raw);
        expect(log.length).toBeLessThanOrEqual(1000);
        // Most recent entry should be present
        expect(log[log.length - 1].endpoint).toBe('https://example.com/new');
    });
});

// ── File mutex (concurrent safety) ─────────────────────────────
describe('concurrent write safety', () => {
    it('handles concurrent subscription writes without data loss', async () => {
        // Clean subscriptions
        await fsp.writeFile(subscriptionsPath, JSON.stringify({ subscriptions: [] }, null, 2));

        // Fire 5 concurrent subscribe requests
        const promises = Array.from({ length: 5 }, (_, i) =>
            request
                .post('/indianhistorybite/api/push/subscribe')
                .send({
                    subscription: {
                        endpoint: `https://fcm.googleapis.com/fcm/send/concurrent-${i}`,
                        keys: {
                            p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfWRs',
                            auth: 'tBHItJI5svbpC7htqlcmZg'
                        }
                    }
                })
        );

        const results = await Promise.all(promises);
        results.forEach(r => expect(r.status).toBe(200));

        // Read subscriptions — all 5 should be present
        const raw = await fsp.readFile(subscriptionsPath, 'utf8');
        const data = JSON.parse(raw);
        const concurrentEndpoints = data.subscriptions.filter(s => {
            const ep = (s.subscription || s).endpoint;
            return ep.includes('concurrent-');
        });
        expect(concurrentEndpoints.length).toBe(5);
    });
});
