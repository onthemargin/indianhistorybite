const crypto = require('crypto');

// We require security.js directly — it exports pure functions and middleware
const security = require('../security');

describe('security module', () => {
    // ── Rate limiter creation ──────────────────────────────────
    describe('rateLimiters', () => {
        it('exports general, refresh, and admin limiters', () => {
            expect(security.rateLimiters.general).toBeDefined();
            expect(security.rateLimiters.refresh).toBeDefined();
            expect(security.rateLimiters.admin).toBeDefined();
        });

        it('each limiter is a function (middleware)', () => {
            expect(typeof security.rateLimiters.general).toBe('function');
            expect(typeof security.rateLimiters.refresh).toBe('function');
            expect(typeof security.rateLimiters.admin).toBe('function');
        });
    });

    // ── API key authentication ─────────────────────────────────
    describe('requireApiKey', () => {
        let req, res, next;

        beforeEach(() => {
            req = { headers: {} };
            res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json: jest.fn().mockReturnThis()
            };
            next = jest.fn();
        });

        afterEach(() => {
            delete process.env.APP_API_KEY;
        });

        it('calls next() when no APP_API_KEY is configured (dev mode)', () => {
            delete process.env.APP_API_KEY;
            security.requireApiKey(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('returns 401 when API key is required but not provided', () => {
            process.env.APP_API_KEY = 'test-secret-key';
            security.requireApiKey(req, res, next);
            expect(res.statusCode).toBe(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'API key required' });
            expect(next).not.toHaveBeenCalled();
        });

        it('returns 401 when provided key is wrong', () => {
            process.env.APP_API_KEY = 'correct-key';
            req.headers['x-api-key'] = 'wrong-key';
            security.requireApiKey(req, res, next);
            expect(res.statusCode).toBe(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
            expect(next).not.toHaveBeenCalled();
        });

        it('returns 401 when key has different length', () => {
            process.env.APP_API_KEY = 'long-correct-key';
            req.headers['x-api-key'] = 'short';
            security.requireApiKey(req, res, next);
            expect(res.statusCode).toBe(401);
            expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
            expect(next).not.toHaveBeenCalled();
        });

        it('calls next() when correct key is provided', () => {
            process.env.APP_API_KEY = 'my-secret';
            req.headers['x-api-key'] = 'my-secret';
            security.requireApiKey(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.json).not.toHaveBeenCalled();
        });

        it('uses timing-safe comparison (same length keys)', () => {
            const spy = jest.spyOn(crypto, 'timingSafeEqual');
            process.env.APP_API_KEY = 'key123';
            req.headers['x-api-key'] = 'key123';
            security.requireApiKey(req, res, next);
            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    // ── Input sanitization ─────────────────────────────────────
    describe('sanitizeInput', () => {
        it('strips HTML tags', () => {
            expect(security.sanitizeInput('<script>alert(1)</script>')).toBe('alert(1)');
        });

        it('escapes ampersand, quotes, and slashes', () => {
            const result = security.sanitizeInput('a & "b" \'c\' /d');
            expect(result).toContain('&amp;');
            expect(result).toContain('&quot;');
            expect(result).toContain('&#x27;');
            expect(result).toContain('&#x2F;');
        });

        it('strips HTML-like patterns including partial tags', () => {
            // < c > is matched by the HTML tag regex and removed
            expect(security.sanitizeInput('x< c >y')).toBe('xy');
            // <b is also matched (the regex makes > optional)
            expect(security.sanitizeInput('a<b')).toBe('a');
            // Full tags are stripped
            expect(security.sanitizeInput('<div>hello</div>')).toBe('hello');
        });

        it('returns non-string input unchanged', () => {
            expect(security.sanitizeInput(42)).toBe(42);
            expect(security.sanitizeInput(null)).toBe(null);
            expect(security.sanitizeInput(undefined)).toBe(undefined);
        });

        it('handles empty string', () => {
            expect(security.sanitizeInput('')).toBe('');
        });
    });

    // ── Security headers ───────────────────────────────────────
    describe('securityHeaders', () => {
        it('returns a middleware function', () => {
            const middleware = security.securityHeaders();
            expect(typeof middleware).toBe('function');
        });
    });

    // ── CSRF token generation and validation ───────────────────
    describe('CSRF tokens', () => {
        it('generateCsrfToken returns a 64-char hex string', () => {
            const token = security.generateCsrfToken();
            expect(token).toMatch(/^[0-9a-f]{64}$/);
        });

        it('generates unique tokens each time', () => {
            const t1 = security.generateCsrfToken();
            const t2 = security.generateCsrfToken();
            expect(t1).not.toBe(t2);
        });

        it('validateCsrfToken passes GET requests without token', () => {
            const req = { method: 'GET', headers: {}, body: {} };
            const res = {};
            const next = jest.fn();
            security.validateCsrfToken(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('validateCsrfToken rejects POST without token', () => {
            const req = { method: 'POST', headers: {}, body: {} };
            const res = {
                status(code) { this.statusCode = code; return this; },
                json: jest.fn().mockReturnThis()
            };
            const next = jest.fn();
            security.validateCsrfToken(req, res, next);
            expect(res.statusCode).toBe(403);
            expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token missing' });
            expect(next).not.toHaveBeenCalled();
        });

        it('validateCsrfToken accepts a valid token via header', () => {
            const token = security.generateCsrfToken();
            const req = { method: 'POST', headers: { 'x-csrf-token': token }, body: {} };
            const res = {};
            const next = jest.fn();
            security.validateCsrfToken(req, res, next);
            expect(next).toHaveBeenCalled();
        });

        it('token is single-use (rejected on second attempt)', () => {
            const token = security.generateCsrfToken();

            // First use succeeds
            const req1 = { method: 'POST', headers: { 'x-csrf-token': token }, body: {} };
            const next1 = jest.fn();
            security.validateCsrfToken(req1, {}, next1);
            expect(next1).toHaveBeenCalled();

            // Second use fails
            const req2 = { method: 'POST', headers: { 'x-csrf-token': token }, body: {} };
            const res2 = {
                status(code) { this.statusCode = code; return this; },
                json: jest.fn().mockReturnThis()
            };
            const next2 = jest.fn();
            security.validateCsrfToken(req2, res2, next2);
            expect(res2.statusCode).toBe(403);
            expect(next2).not.toHaveBeenCalled();
        });
    });

    // ── Secure error handler ───────────────────────────────────
    describe('secureErrorHandler', () => {
        it('returns 500 with generic message in production', () => {
            const origEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'production';
            const err = new Error('internal secret');
            const req = {};
            const res = {
                status(code) { this.statusCode = code; return this; },
                json: jest.fn().mockReturnThis()
            };
            const next = jest.fn();
            // Suppress console.error output during test
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
            security.secureErrorHandler(err, req, res, next);
            expect(res.statusCode).toBe(500);
            expect(res.json).toHaveBeenCalledWith({
                error: 'An error occurred processing your request'
            });
            spy.mockRestore();
            process.env.NODE_ENV = origEnv;
        });

        it('returns error message in development', () => {
            const origEnv = process.env.NODE_ENV;
            process.env.NODE_ENV = 'development';
            const err = new Error('some debug info');
            const req = {};
            const res = {
                status(code) { this.statusCode = code; return this; },
                json: jest.fn().mockReturnThis()
            };
            const next = jest.fn();
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
            security.secureErrorHandler(err, req, res, next);
            expect(res.json).toHaveBeenCalledWith({ error: 'some debug info' });
            spy.mockRestore();
            process.env.NODE_ENV = origEnv;
        });
    });

    // ── Request logger ─────────────────────────────────────────
    describe('requestLogger', () => {
        it('is a middleware that calls next()', () => {
            const req = { ip: '1.2.3.4', method: 'GET', path: '/', get: () => 'test-agent' };
            const res = { on: jest.fn() };
            const next = jest.fn();
            security.requestLogger(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(res.on).toHaveBeenCalledWith('finish', expect.any(Function));
        });
    });
});
