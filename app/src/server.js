const path = require('path');
const fs = require('fs');

// Load environment variables
// Try production path first, fall back to local .env
const dotenv = require('dotenv');
if (process.env.NODE_ENV === 'production' && fs.existsSync('/etc/indianhistorybite/.env')) {
    dotenv.config({ path: '/etc/indianhistorybite/.env' });
} else {
    dotenv.config();
}

const express = require('express');
const cors = require('cors');
const app = express();
const security = require('./security');
const scheduler = require('./story-scheduler');

app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx is the only proxy; enables real client IP for rate limiting

const port = process.env.PORT || 3001;
const basePath = process.env.BASE_PATH || '/indianhistorybite';

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);

if (!pushConfigured) {
    console.warn('Web push is disabled because VAPID keys are not fully configured');
}

function buildPushPublicConfig() {
    return {
        pushSupported: pushConfigured,
        vapidPublicKey: pushConfigured ? vapidPublicKey : null
    };
}

const handleAsyncRoute = (handler) => async (req, res, next) => {
    try {
        await handler(req, res, next);
    } catch (error) {
        next(error);
    }
};

// Security middleware
app.use(security.requestLogger);
app.use(security.securityHeaders());
app.use(security.rateLimiters.general);

// CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : [];

        // Allow requests without origin (same-origin, Postman, curl, etc.)
        // or if origin is in the allowed list
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.length === 0) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    maxAge: 86400 // Cache preflight requests for 24 hours
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(basePath, express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Routes
const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Public endpoint - get current stored result only, with optional deep-link by date key
const getResultHandler = async (req, res) => {
    try {
        const rawDateKey = typeof req.query.story === 'string' && req.query.story.trim()
            ? req.query.story.trim()
            : typeof req.query.storyDateKey === 'string' && req.query.storyDateKey.trim()
                ? req.query.storyDateKey.trim()
                : null;

        if (rawDateKey && !VALID_DATE_RE.test(rawDateKey)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
        }
        const storyDateKey = rawDateKey;
        const storedStory = await scheduler.loadDailyStoryFromStorage(storyDateKey);
        if (storedStory) {
            return res.json(scheduler.setCurrentResultFromStoryRecord(storedStory));
        }

        return res.status(404).json({
            ...scheduler.createEmptyCurrentResult(),
            error: storyDateKey
                ? `No saved daily story found for ${storyDateKey}`
                : 'No daily story has been generated yet'
        });
    } catch (error) {
        console.error('Error loading stored story:', error);
        return res.status(500).json({
            response: 'Error loading stored story',
            isProcessing: false,
            lastModified: new Date().toISOString(),
            error: process.env.NODE_ENV === 'production' ? 'Storage load failed' : error.message
        });
    }
};
app.get(basePath + '/api/result', getResultHandler);
app.get('/api/result', getResultHandler);

app.get(basePath + '/api/config', (req, res) => {
    res.json(buildPushPublicConfig());
});
app.get('/api/config', (req, res) => {
    res.json(buildPushPublicConfig());
});

// Push subscription routes with rate limiting and validation
const pushSubscribeMiddleware = [
    security.rateLimiters.pushSubscribe,
    security.validators.pushSubscription,
    security.handleValidationErrors
];

app.post(basePath + '/api/push/subscribe', ...pushSubscribeMiddleware, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.upsertPushSubscription(req.body.subscription);
    res.json({ success: true, ...result });
}));
app.post('/api/push/subscribe', ...pushSubscribeMiddleware, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.upsertPushSubscription(req.body.subscription);
    res.json({ success: true, ...result });
}));

const pushUnsubscribeMiddleware = [
    security.rateLimiters.pushUnsubscribe,
    security.validators.pushSubscription,
    security.handleValidationErrors
];

app.post(basePath + '/api/push/unsubscribe', ...pushUnsubscribeMiddleware, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.removePushSubscription(req.body.subscription);
    res.json({ success: true, ...result });
}));
app.post('/api/push/unsubscribe', ...pushUnsubscribeMiddleware, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.removePushSubscription(req.body.subscription);
    res.json({ success: true, ...result });
}));

// Push delivery status tracking (protected)
const postPushDeliveryHandler = async (req, res) => {
    const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint.trim() : '';
    const status = req.body && typeof req.body.status === 'string' ? req.body.status.trim() : '';
    const allowedStatuses = new Set(['sent', 'failed', 'expired']);

    if (!endpoint || !allowedStatuses.has(status)) {
        return res.status(400).json({ error: 'endpoint and valid status (sent/failed/expired) are required' });
    }

    try {
        const subscription = await scheduler.recordPushDeliveryStatus({
            endpoint,
            status,
            storyDateKey: req.body && req.body.storyDateKey,
            errorMessage: req.body && req.body.errorMessage,
            deliveredAt: req.body && req.body.deliveredAt
        });
        return res.json({ success: true, subscription });
    } catch (error) {
        console.error('Push delivery status error:', error);
        return res.status(500).json({
            error: process.env.NODE_ENV === 'production' ? 'Failed to record push delivery status' : error.message,
            success: false
        });
    }
};
app.post(basePath + '/api/push/delivery-status', security.rateLimiters.admin, security.requireApiKey, postPushDeliveryHandler);
app.post('/api/push/delivery-status', security.rateLimiters.admin, security.requireApiKey, postPushDeliveryHandler);

// Admin status endpoint (protected)
const getAdminStatusHandler = async (req, res) => {
    try {
        return res.json(await scheduler.buildAdminStatusResponse());
    } catch (error) {
        console.error('Admin status error:', error);
        return res.status(500).json({
            error: process.env.NODE_ENV === 'production' ? 'Failed to load admin status' : error.message,
            success: false
        });
    }
};
app.get(basePath + '/api/admin/status', security.rateLimiters.admin, security.requireApiKey, getAdminStatusHandler);
app.get('/api/admin/status', security.rateLimiters.admin, security.requireApiKey, getAdminStatusHandler);

// Protected endpoint - generate and persist the next daily story
const postRefreshHandler = async (req, res) => {
    console.log('Manual daily story generation triggered');
    try {
        const result = await scheduler.generateAndStoreDailyStory({
            storyDateKey: req.body && req.body.storyDateKey,
            notificationSent: req.body && typeof req.body.notificationSent === 'boolean'
                ? req.body.notificationSent
                : false
        });
        res.json({ message: 'Daily story generated', success: true, result });
    } catch (error) {
        console.error('Daily story generation error:', error);
        res.status(500).json({
            error: process.env.NODE_ENV === 'production' ? 'Failed to generate daily story' : error.message,
            success: false
        });
    }
};

const refreshMiddleware = [security.rateLimiters.refresh, security.requireApiKey];
app.post(basePath + '/api/refresh', ...refreshMiddleware, postRefreshHandler);
app.post('/api/refresh', ...refreshMiddleware, postRefreshHandler);
app.post(basePath + '/api/generate', ...refreshMiddleware, postRefreshHandler);
app.post('/api/generate', ...refreshMiddleware, postRefreshHandler);
app.post(basePath + '/api/cron/generate', ...refreshMiddleware, postRefreshHandler);
app.post('/api/cron/generate', ...refreshMiddleware, postRefreshHandler);

app.post(basePath + '/api/jobs/daily-story', security.requireApiKey, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.runDailyStoryJob({ storyDateKey: req.body && req.body.storyDateKey });
    res.json({ success: true, result });
}));
app.post('/api/jobs/daily-story', security.requireApiKey, handleAsyncRoute(async (req, res) => {
    const result = await scheduler.runDailyStoryJob({ storyDateKey: req.body && req.body.storyDateKey });
    res.json({ success: true, result });
}));

app.get(basePath, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(basePath + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

scheduler.initializeCurrentStory();

// Error handling middleware (must be last)
app.use(security.secureErrorHandler);

// Start server
const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Access the app at ${basePath}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Web push notifications: ${pushConfigured ? 'ENABLED' : 'DISABLED'}`);
    if (process.env.APP_API_KEY) {
        console.log('API key protection: ENABLED');
    } else {
        console.log('WARNING: API key protection is DISABLED (set APP_API_KEY)');
    }
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    gracefulShutdown();
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    gracefulShutdown();
});

function gracefulShutdown() {
    console.log('Shutting down server...');

    // Close server
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });

    // Force close after 10 seconds
    setTimeout(() => {
        console.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
}
