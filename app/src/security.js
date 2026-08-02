const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

// Rate limiting configurations
const createRateLimiter = (windowMs, max, message) => {
    return rateLimit({
        windowMs,
        max,
        message,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            res.status(429).json({
                error: message,
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
    });
};

// Different rate limits for different endpoints
const rateLimiters = {
    // General API rate limit - 100 requests per 15 minutes
    general: createRateLimiter(
        15 * 60 * 1000,
        100,
        'Too many requests, please try again later.'
    ),
    
    // Strict limit for manual generation/refresh endpoints
    refresh: createRateLimiter(
        60 * 60 * 1000,
        3,
        'Refresh limit exceeded. Please wait before requesting new content.'
    ),

    // Tight rate limit for push subscription writes
    pushSubscribe: createRateLimiter(
        15 * 60 * 1000,
        10,
        'Push subscription limit exceeded. Please try again later.'
    ),

    // Tight but slightly more permissive limit for unsubscribe requests
    pushUnsubscribe: createRateLimiter(
        15 * 60 * 1000,
        20,
        'Push unsubscribe limit exceeded. Please try again later.'
    ),

    // Very strict for admin endpoints
    admin: createRateLimiter(
        60 * 60 * 1000,
        3,
        'Admin request limit exceeded.'
    )
};

// Security headers configuration
const securityHeaders = () => {
    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'"],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "https:"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: []
            }
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true
        },
        referrerPolicy: {
            policy: 'strict-origin-when-cross-origin'
        }
    });
};

// Input validation rules
const validators = {
    prompt: [
        body('prompt')
            .trim()
            .isLength({ min: 1, max: 5000 })
            .withMessage('Prompt must be between 1 and 5000 characters')
            .matches(/^[a-zA-Z0-9\s.,!?'"()-]+$/)
            .withMessage('Prompt contains invalid characters')
    ],
    pushSubscription: [
        body('subscription')
            .exists()
            .withMessage('Subscription payload is required')
            .bail()
            .isObject()
            .withMessage('Subscription payload must be an object'),
        body('subscription.endpoint')
            .isString()
            .withMessage('Subscription endpoint is required')
            .bail()
            .isLength({ min: 1, max: 2048 })
            .withMessage('Subscription endpoint must be between 1 and 2048 characters')
            .bail()
            .matches(/^https:\/\/[^\s]+$/)
            .withMessage('Subscription endpoint must be a valid HTTPS URL'),
        body('subscription.expirationTime')
            .optional({ nullable: true })
            .custom((value) => value === null || Number.isInteger(value))
            .withMessage('Subscription expirationTime must be null or an integer timestamp'),
        body('subscription.keys')
            .exists()
            .withMessage('Subscription keys are required')
            .bail()
            .isObject()
            .withMessage('Subscription keys must be an object'),
        body('subscription.keys.p256dh')
            .isString()
            .withMessage('Subscription key p256dh is required')
            .bail()
            .matches(/^[A-Za-z0-9_-]{20,512}$/)
            .withMessage('Subscription key p256dh must be valid base64url'),
        body('subscription.keys.auth')
            .isString()
            .withMessage('Subscription key auth is required')
            .bail()
            .matches(/^[A-Za-z0-9_-]{8,256}$/)
            .withMessage('Subscription key auth must be valid base64url')
    ],
    pushUnsubscribe: [
        body('endpoint')
            .isString()
            .withMessage('Subscription endpoint is required')
            .bail()
            .isLength({ min: 1, max: 2048 })
            .withMessage('Subscription endpoint must be between 1 and 2048 characters')
            .bail()
            .matches(/^https:\/\/[^\s]+$/)
            .withMessage('Subscription endpoint must be a valid HTTPS URL')
    ]
};

// Validate request results
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            error: 'Validation failed',
            details: errors.array().map(e => e.msg)
        });
    }
    next();
};

// API key authentication middleware
const requireApiKey = (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    const expectedKey = process.env.APP_API_KEY;
    
    if (!expectedKey) {
        return res.status(503).json({ error: 'APP_API_KEY is not configured for this protected endpoint' });
    }
    
    if (!providedKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    // Constant-time comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedKey);
    const expectedBuffer = Buffer.from(expectedKey);
    
    if (providedBuffer.length !== expectedBuffer.length) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
};

// Google OIDC authentication (for Cloud Scheduler → protected endpoints).
// A single OAuth2Client is reused; it fetches and caches Google's public keys.
let oauthClient = null;
const getOAuthClient = () => {
    if (!oauthClient) {
        oauthClient = new OAuth2Client();
    }
    return oauthClient;
};

// Service accounts allowed to call OIDC-protected endpoints, from OIDC_ALLOWED_SA
// (comma-separated). Empty ⇒ OIDC is not configured and Bearer tokens are ignored.
const allowedServiceAccounts = () =>
    (process.env.OIDC_ALLOWED_SA || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

// Verify a Google-signed OIDC ID token: valid signature, matching audience (when
// OIDC_AUDIENCE is set), verified email, and an allowlisted service-account email.
// Throws on any failure. Returns the token payload on success.
const verifyOidcToken = async (idToken) => {
    const audience = process.env.OIDC_AUDIENCE || null;
    const ticket = await getOAuthClient().verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload || payload.email_verified !== true) {
        throw new Error('OIDC token email not verified');
    }
    if (!allowedServiceAccounts().includes(payload.email)) {
        throw new Error('OIDC token email not allowlisted');
    }
    return payload;
};

// Require a valid Google OIDC Bearer token from an allowlisted service account.
// No API-key fallback: this is for machine-only endpoints (e.g. the Cloud
// Scheduler daily-story job) after the key→OIDC migration is complete.
const requireOidc = async (req, res, next) => {
    if (allowedServiceAccounts().length === 0) {
        return res.status(503).json({ error: 'OIDC is not configured for this protected endpoint' });
    }

    const authHeader = req.headers['authorization'] || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!bearer) {
        return res.status(401).json({ error: 'OIDC token required' });
    }

    try {
        await verifyOidcToken(bearer);
        return next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid OIDC token' });
    }
};

// CSRF token generation and validation
const csrfTokens = new Map();

const generateCsrfToken = () => {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + (60 * 60 * 1000); // 1 hour
    csrfTokens.set(token, expires);
    
    // Clean up expired tokens
    for (const [t, exp] of csrfTokens.entries()) {
        if (exp < Date.now()) {
            csrfTokens.delete(t);
        }
    }
    
    return token;
};

const validateCsrfToken = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return next();
    }
    
    const token = req.headers['x-csrf-token'] || req.body._csrf;
    
    if (!token) {
        return res.status(403).json({ error: 'CSRF token missing' });
    }
    
    const expires = csrfTokens.get(token);
    
    if (!expires || expires < Date.now()) {
        csrfTokens.delete(token);
        return res.status(403).json({ error: 'Invalid or expired CSRF token' });
    }
    
    // Token is valid, delete it (one-time use)
    csrfTokens.delete(token);
    next();
};

// Request logging middleware
const requestLogger = (req, res, next) => {
    const start = Date.now();
    const ip = req.ip || req.connection.remoteAddress;
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const log = {
            timestamp: new Date().toISOString(),
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: `${duration}ms`,
            ip: ip,
            userAgent: req.get('user-agent')
        };
        
        // Log suspicious activity
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) {
            console.log('SECURITY:', JSON.stringify(log));
        }
    });
    
    next();
};

// Sanitize user input
const sanitizeInput = (input) => {
    if (typeof input !== 'string') return input;
    
    // Remove any HTML tags
    input = input.replace(/<[^>]*>?/gm, '');
    
    // Escape special characters
    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        "/": '&#x2F;'
    };
    
    return input.replace(/[&<>"'/]/g, char => escapeMap[char]);
};

// Error handler that doesn't expose internal details
const secureErrorHandler = (err, req, res, next) => {
    console.error('Error:', err.stack);
    
    // Don't expose internal error details
    const message = process.env.NODE_ENV === 'production' 
        ? 'An error occurred processing your request'
        : err.message;
    
    res.status(err.status || 500).json({
        error: message
    });
};

module.exports = {
    rateLimiters,
    securityHeaders,
    validators,
    handleValidationErrors,
    requireApiKey,
    requireOidc,
    generateCsrfToken,
    validateCsrfToken,
    requestLogger,
    sanitizeInput,
    secureErrorHandler
};
