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

beforeAll((done) => {
    const runtimeDataDir = path.resolve(__dirname, '../../../runtime/data');

    // Ensure runtime dir exists, remove existing story for clean state
    fsp.mkdir(runtimeDataDir, { recursive: true })
        .then(() => fsp.unlink(path.join(runtimeDataDir, 'current-story.json')).catch(() => {}))
        .then(() => {
            // Patch express.application.listen to capture the server and use port 0
            const originalListen = express.application.listen;
            express.application.listen = function (...args) {
                // Call original with port 0, 127.0.0.1, and a callback
                server = originalListen.call(this, 0, '127.0.0.1', () => {
                    request = supertest(server);
                    // Restore original listen
                    express.application.listen = originalListen;
                    done();
                });
                return server;
            };

            // Clear cached modules
            const serverPath = require.resolve('../server');
            delete require.cache[serverPath];
            const secPath = require.resolve('../security');
            delete require.cache[secPath];

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

describe('GET /indianhistorybite/api/result', () => {
    it('returns 404 when no story has been generated', async () => {
        const res = await request.get('/indianhistorybite/api/result');
        expect(res.status).toBe(404);
        expect(res.body.error).toBeDefined();
        expect(res.body.response).toBeDefined();
    });

    it('returns stored story after one is saved', async () => {
        const runtimeDataDir = path.resolve(__dirname, '../../../runtime/data');
        const storyRecord = {
            story: {
                name: 'Test Hero',
                title: 'A Test Title',
                content: 'Test content about history.',
                shareableQuote: 'Quote here'
            },
            generatedAt: '2026-03-29T10:00:00.000Z',
            storyDateKey: '2026-03-29',
            notificationSent: false
        };
        await fsp.writeFile(
            path.join(runtimeDataDir, 'current-story.json'),
            JSON.stringify(storyRecord, null, 2)
        );

        const res = await request.get('/indianhistorybite/api/result');
        expect(res.status).toBe(200);
        expect(res.body.response).toEqual(expect.objectContaining({
            name: 'Test Hero',
            content: 'Test content about history.'
        }));
        expect(res.body.storyDateKey).toBe('2026-03-29');
        expect(res.body.isProcessing).toBe(false);
        expect(res.body.lastModified).toBeDefined();
    });

    it('JSON response has expected structure', async () => {
        const res = await request.get('/indianhistorybite/api/result');
        expect(res.headers['content-type']).toMatch(/json/);
        const body = res.body;
        expect(body).toHaveProperty('response');
        expect(body).toHaveProperty('isProcessing');
        expect(body).toHaveProperty('lastModified');
    });
});

describe('POST /indianhistorybite/api/refresh', () => {
    it('returns 401 without API key', async () => {
        const res = await request
            .post('/indianhistorybite/api/refresh')
            .send({});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('API key required');
    });

    it('returns 401 with wrong API key', async () => {
        const res = await request
            .post('/indianhistorybite/api/refresh')
            .set('x-api-key', 'wrong-key-here')
            .send({});
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Invalid API key');
    });
});

describe('storyDateKey validation', () => {
    const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    it('accepts valid YYYY-MM-DD dates', () => {
        expect(VALID_DATE_RE.test('2026-03-29')).toBe(true);
        expect(VALID_DATE_RE.test('1947-08-15')).toBe(true);
    });

    it('rejects invalid strings', () => {
        expect(VALID_DATE_RE.test('not-a-date')).toBe(false);
        expect(VALID_DATE_RE.test('2026/03/29')).toBe(false);
        expect(VALID_DATE_RE.test('2026-3-9')).toBe(false);
        expect(VALID_DATE_RE.test('')).toBe(false);
        expect(VALID_DATE_RE.test('29-03-2026')).toBe(false);
    });

    it('rejects strings with extra content', () => {
        expect(VALID_DATE_RE.test('2026-03-29; DROP TABLE')).toBe(false);
        expect(VALID_DATE_RE.test('2026-03-29\n')).toBe(false);
    });
});

describe('CORS policy', () => {
    it('blocks cross-origin requests from arbitrary origins', async () => {
        const res = await request
            .get('/indianhistorybite/api/result')
            .set('Origin', 'https://evil.com');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows same-origin requests (no Origin header)', async () => {
        const res = await request.get('/indianhistorybite/api/result');
        expect(res.status).not.toBe(403);
    });

    it('allows requests from the production origin', async () => {
        const res = await request
            .get('/indianhistorybite/api/result')
            .set('Origin', 'https://app.gyatso.me');
        expect(res.headers['access-control-allow-origin']).toBe('https://app.gyatso.me');
    });
});

describe('alternate route paths (without basePath prefix)', () => {
    it('GET /api/result also works', async () => {
        const res = await request.get('/api/result');
        expect([200, 404]).toContain(res.status);
        expect(res.headers['content-type']).toMatch(/json/);
    });
});
