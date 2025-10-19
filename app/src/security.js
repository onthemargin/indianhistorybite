const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');

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
    
    // Strict limit for refresh endpoint - 10 requests per hour
    refresh: createRateLimiter(
        60 * 60 * 1000,
        10,
        'Refresh limit exceeded. Please wait before requesting new content.'
    ),
    
    // Subscribe endpoint - 5 requests per hour
    subscribe: createRateLimiter(
        60 * 60 * 1000,
        5,
        'Subscription limit exceeded. Please try again later.'
    ),
    
    // Very strict for admin endpoints - 5 requests per hour
    admin: createRateLimiter(
        60 * 60 * 1000,
        5,
        'Admin request limit exceeded.'
    )
};

// Security headers configuration
const securityHeaders = () => {
    return helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
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
    
    subscription: [
        body('endpoint')
            .isURL()
            .withMessage('Invalid subscription endpoint'),
        body('keys.p256dh')
            .isBase64()
            .withMessage('Invalid p256dh key'),
        body('keys.auth')
            .isBase64()
            .withMessage('Invalid auth key')
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
    const providedKey = req.headers['x-api-key'] || req.query.apikey;
    const expectedKey = process.env.APP_API_KEY;
    
    if (!expectedKey) {
        // If no API key is configured, allow access (for development)
        return next();
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
    generateCsrfToken,
    validateCsrfToken,
    requestLogger,
    sanitizeInput,
    secureErrorHandler
};