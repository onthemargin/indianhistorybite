const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// Load environment variables
// Try production path first, fall back to local .env
const dotenv = require('dotenv');
if (process.env.NODE_ENV === 'production' && fs.existsSync('/etc/indianhistorybite/.env')) {
    dotenv.config({ path: '/etc/indianhistorybite/.env' });
} else {
    dotenv.config();
}

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const security = require('./security');

app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx is the only proxy; enables real client IP for rate limiting

const port = process.env.PORT || 3001;
const basePath = process.env.BASE_PATH || '/indianhistorybite';

// Prompt template from environment variable
const promptText = process.env.PROMPT_TEXT || '';

const runtimeDataDir = path.resolve(__dirname, '../../runtime/data');
const currentStoryPath = path.join(runtimeDataDir, 'current-story.json');

function createEmptyCurrentResult() {
    return {
        response: 'No daily story has been generated yet',
        isProcessing: false,
        lastModified: null,
        error: null
    };
}

// Store current result
let currentResult = createEmptyCurrentResult();

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

// Log to stdout/stderr — captured by Cloud Logging
function logRequest(prompt, response, error = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        prompt: prompt || null,
        ...(error ? { error } : { response }),
    };
    if (error) {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

// Execute Claude API call
async function executeClaudeAPICall(prompt) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
        const error = 'CLAUDE_API_KEY not configured';
        logRequest(prompt, null, error);
        throw new Error(error);
    }

    try {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 4000,
                messages: [{ role: 'user', content: prompt }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                timeout: 60000
            }
        );

        if (!response.data || !response.data.content || !response.data.content[0]) {
            throw new Error('Invalid response from Claude API');
        }

        let claudeResponse = response.data.content[0].text;

        // Extract JSON from markdown if present
        const jsonMatch = claudeResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
            claudeResponse = jsonMatch[1];
        }

        // Try to parse and validate JSON
        try {
            let parsedJson;
            try {
                parsedJson = JSON.parse(claudeResponse);
            } catch (firstError) {
                console.log('Initial parse failed, attempting to fix JSON...');

                let cleaned = claudeResponse.trim();
                cleaned = cleaned.replace(/"content":\s*"((?:[^"\\]|\\.)*)"/gs, (match, content) => {
                    const escaped = content
                        .replace(/\n/g, '\\n')
                        .replace(/\r/g, '\\r')
                        .replace(/\t/g, '\\t');
                    return `"content": "${escaped}"`;
                });
                cleaned = cleaned.replace(/"shareableQuote":\s*"((?:[^"\\]|\\.)*)"/gs, (match, content) => {
                    const escaped = content
                        .replace(/\n/g, '\\n')
                        .replace(/\r/g, '\\r')
                        .replace(/\t/g, '\\t');
                    return `"shareableQuote": "${escaped}"`;
                });

                parsedJson = JSON.parse(cleaned);
            }

            if (parsedJson && parsedJson.name && parsedJson.content) {
                logRequest(prompt, parsedJson);
                return parsedJson;
            }
        } catch (e) {
            console.error('JSON parse error:', e.message);
            console.error('Failed response sample:', claudeResponse.substring(0, 500));
        }

        logRequest(prompt, claudeResponse);
        throw new Error('Claude API did not return a valid story JSON payload');
    } catch (error) {
        console.error('Claude API error:', error.message);
        logRequest(prompt, null, error.message);
        throw error;
    }
}

async function ensureRuntimeDataDir() {
    await fsp.mkdir(runtimeDataDir, { recursive: true });
}

async function saveDailyStory(storyRecord) {
    await ensureRuntimeDataDir();
    await fsp.writeFile(currentStoryPath, JSON.stringify(storyRecord, null, 2));
}

async function loadDailyStoryFromStorage() {
    try {
        const raw = await fsp.readFile(currentStoryPath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function setCurrentResultFromStoryRecord(storyRecord) {
    currentResult = {
        response: storyRecord.story,
        isProcessing: false,
        lastModified: storyRecord.generatedAt,
        error: null,
        storyDateKey: storyRecord.storyDateKey,
        generatedAt: storyRecord.generatedAt,
        notificationSent: Boolean(storyRecord.notificationSent)
    };
    return currentResult;
}

function setCurrentResultError(message, internalError) {
    currentResult = {
        response: message,
        isProcessing: false,
        lastModified: new Date().toISOString(),
        error: internalError
    };
    return currentResult;
}
// Queue for pending requests
let requestQueue = [];
let isCurrentlyProcessing = false;

async function generateAndStoreDailyStory(options = {}) {
    if (isCurrentlyProcessing) {
        return new Promise((resolve, reject) => {
            requestQueue.push({ resolve, reject, options });
        });
    }

    isCurrentlyProcessing = true;
    currentResult = {
        ...currentResult,
        isProcessing: true,
        error: null
    };

    try {
        const basePrompt = promptText.trim();
        if (!basePrompt) {
            throw new Error('PROMPT_TEXT environment variable is not set');
        }

        const generationTimestamp = new Date();
        const generatedAt = generationTimestamp.toISOString();
        const storyDateKey = options.storyDateKey || generatedAt.slice(0, 10);
        const randomSeed = Math.random().toString(36).substring(2, 10);
        const uniqueId = Date.now() + Math.random();
        const randomNumber = Math.floor(Math.random() * 1000000);

        const prompt = `${basePrompt}

Generation Metadata:
- Story Date Key: ${storyDateKey}
- Generation ID: ${randomSeed}
- Timestamp: ${generatedAt}
- Unique Request ID: ${uniqueId}
- Random Seed: ${randomNumber}

CRITICAL INSTRUCTIONS:
1. Generate exactly one story for the provided story date key
2. Return valid JSON with name, title, content, and shareableQuote fields
3. The response must be suitable for saving as the daily featured story`;

        const storyPayload = await executeClaudeAPICall(prompt);
        const storyRecord = {
            story: {
                name: storyPayload.name,
                title: storyPayload.title || '',
                content: storyPayload.content,
                shareableQuote: storyPayload.shareableQuote || ''
            },
            generatedAt,
            storyDateKey,
            notificationSent: options.notificationSent ?? false
        };

        await saveDailyStory(storyRecord);
        return setCurrentResultFromStoryRecord(storyRecord);
    } catch (error) {
        setCurrentResultError(
            'Error generating daily story',
            process.env.NODE_ENV === 'production' ? 'Processing failed' : error.message
        );
        throw error;
    } finally {
        isCurrentlyProcessing = false;
        if (requestQueue.length > 0) {
            const nextRequest = requestQueue.shift();
            generateAndStoreDailyStory(nextRequest.options)
                .then(nextRequest.resolve)
                .catch(nextRequest.reject);
        }
    }
}

async function initializeCurrentStory() {
    try {
        const storedStory = await loadDailyStoryFromStorage();
        if (storedStory) {
            setCurrentResultFromStoryRecord(storedStory);
            console.log(`Loaded current daily story for ${storedStory.storyDateKey}`);
        } else {
            currentResult = createEmptyCurrentResult();
            console.log('No stored daily story found on startup');
        }
    } catch (error) {
        console.error('Failed to load stored daily story:', error.message);
        setCurrentResultError(
            'Stored daily story could not be loaded',
            process.env.NODE_ENV === 'production' ? 'Storage load failed' : error.message
        );
    }
}

// Routes
// Public endpoint - get current stored result only
const getResultHandler = async (req, res) => {
    try {
        const storedStory = await loadDailyStoryFromStorage();
        if (storedStory) {
            return res.json(setCurrentResultFromStoryRecord(storedStory));
        }

        return res.status(404).json({
            ...createEmptyCurrentResult(),
            error: 'No daily story has been generated yet'
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

// Protected endpoint - generate and persist the next daily story
const postRefreshHandler = async (req, res) => {
    console.log('Manual daily story generation triggered');
    try {
        const result = await generateAndStoreDailyStory({
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
app.post(basePath + '/api/refresh', security.requireApiKey, postRefreshHandler);
app.post('/api/refresh', security.requireApiKey, postRefreshHandler);

app.get(basePath, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(basePath + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initializeCurrentStory();

// Error handling middleware (must be last)
app.use(security.secureErrorHandler);

// Start server
const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Access the app at ${basePath}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
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
