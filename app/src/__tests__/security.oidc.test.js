// Tests for OIDC-or-API-key auth on the scheduler-driven daily-story endpoint.
// google-auth-library is mocked so no network / real Google keys are needed.

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
        verifyIdToken: (...args) => mockVerifyIdToken(...args)
    }))
}));

const security = require('../security');

// Build a resolved verifyIdToken ticket with the given payload.
const ticketWith = (payload) => Promise.resolve({ getPayload: () => payload });

describe('requireApiKeyOrOidc', () => {
    let req, res, next;
    const SA = 'indianhistorybite-daily-story@test-project.iam.gserviceaccount.com';
    const AUD = 'https://app.gyatso.me/indianhistorybite/api/jobs/daily-story';

    beforeEach(() => {
        mockVerifyIdToken.mockReset();
        req = { headers: {} };
        res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json: jest.fn().mockReturnThis()
        };
        next = jest.fn();
        process.env.APP_API_KEY = 'the-legacy-key';
        process.env.OIDC_ALLOWED_SA = SA;
        process.env.OIDC_AUDIENCE = AUD;
    });

    afterEach(() => {
        delete process.env.APP_API_KEY;
        delete process.env.OIDC_ALLOWED_SA;
        delete process.env.OIDC_AUDIENCE;
    });

    it('is exported as a function', () => {
        expect(typeof security.requireApiKeyOrOidc).toBe('function');
    });

    it('allows a valid OIDC token from an allowlisted, verified SA', async () => {
        mockVerifyIdToken.mockReturnValue(ticketWith({ email: SA, email_verified: true }));
        req.headers['authorization'] = 'Bearer good.token.here';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });

    it('verifies the token against the configured audience', async () => {
        mockVerifyIdToken.mockReturnValue(ticketWith({ email: SA, email_verified: true }));
        req.headers['authorization'] = 'Bearer good.token.here';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(mockVerifyIdToken).toHaveBeenCalledWith(
            expect.objectContaining({ idToken: 'good.token.here', audience: AUD })
        );
    });

    it('rejects a token whose email is not allowlisted', async () => {
        mockVerifyIdToken.mockReturnValue(ticketWith({ email: 'attacker@evil.com', email_verified: true }));
        req.headers['authorization'] = 'Bearer good.token.here';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects a token whose email is not verified', async () => {
        mockVerifyIdToken.mockReturnValue(ticketWith({ email: SA, email_verified: false }));
        req.headers['authorization'] = 'Bearer good.token.here';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('rejects when signature verification throws (bad/expired token)', async () => {
        mockVerifyIdToken.mockImplementation(() => Promise.reject(new Error('invalid signature')));
        req.headers['authorization'] = 'Bearer bad.token';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('falls back to the API key when no Bearer token is present', async () => {
        req.headers['x-api-key'] = 'the-legacy-key';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it('rejects when neither Bearer token nor API key is provided', async () => {
        await security.requireApiKeyOrOidc(req, res, next);
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('ignores OIDC and uses the API key when OIDC is not configured', async () => {
        delete process.env.OIDC_ALLOWED_SA;
        req.headers['authorization'] = 'Bearer some.token';
        req.headers['x-api-key'] = 'the-legacy-key';
        await security.requireApiKeyOrOidc(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
});
