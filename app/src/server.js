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
const axios = require('axios');
const cors = require('cors');

const app = express();
const security = require('./security');

app.disable('x-powered-by');
app.set('trust proxy', 1); // nginx is the only proxy; enables real client IP for rate limiting

const port = process.env.PORT || 3001;
const basePath = process.env.BASE_PATH || '/indianhistorybite';

// Runtime directories
const runtimeDir = process.env.RUNTIME_DIR || path.join(__dirname, '../../runtime');
const promptFile = path.join(runtimeDir, 'data', 'prompt.txt');
const logFile = path.join(runtimeDir, 'logs', 'claude_runs.log');

// Store current result
let currentResult = {
    response: 'Waiting for prompt... Edit prompt.txt and save to see results here.',
    isProcessing: false,
    lastModified: null,
    error: null
};

// Ensure directories exist
[path.dirname(promptFile), path.dirname(logFile)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

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

// Enhanced logging with PST time
function logRequest(prompt, response, error = null) {
    const now = new Date();
    const utcTimestamp = now.toISOString();

    // Convert to PST (UTC-8) or PDT (UTC-7) depending on DST
    const pstTimestamp = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const pstString = pstTimestamp.toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const separator = '='.repeat(80);
    const logEntry = `
${separator}
TIMESTAMP (UTC): ${utcTimestamp}
TIMESTAMP (PST): ${pstString}
${separator}

PROMPT SENT:
${prompt || 'No prompt'}

${separator}

${error ? `ERROR:\n${error}` : `RESPONSE RECEIVED:\n${typeof response === 'string' ? response : JSON.stringify(response, null, 2)}`}

${separator}

`;
    try {
        fs.appendFileSync(logFile, logEntry);
        console.log(`[${pstString} PST] Request logged - ${error ? 'ERROR' : 'SUCCESS'}`);
    } catch (err) {
        console.error('Failed to write log:', err.message);
    }
}

// Execute Claude API call
async function executeClaudeAPICall(prompt) {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
        const error = 'CLAUDE_API_KEY not configured';
        currentResult = {
            response: 'API key not configured',
            isProcessing: false,
            lastModified: new Date().toISOString(),
            error: error
        };
        logRequest(prompt, null, error);
        return;
    }

    try {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-haiku-20241022',
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

        if (response.data && response.data.content && response.data.content[0]) {
            let claudeResponse = response.data.content[0].text;

            // Extract JSON from markdown if present
            const jsonMatch = claudeResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch) {
                claudeResponse = jsonMatch[1];
            }

            // Try to parse and validate JSON
            try {
                // First, try parsing as-is
                let parsedJson;
                try {
                    parsedJson = JSON.parse(claudeResponse);
                } catch (firstError) {
                    // If parsing fails, try to fix common issues
                    console.log('Initial parse failed, attempting to fix JSON...');

                    // Remove any BOM or invisible characters
                    let cleaned = claudeResponse.trim();

                    // Fix: Replace literal newlines and tabs in string values with escaped versions
                    // This regex finds strings and escapes control characters within them
                    cleaned = cleaned.replace(/"content":\s*"((?:[^"\\]|\\.)*)"/gs, (match, content) => {
                        // Escape newlines, tabs, and other control characters
                        const escaped = content
                            .replace(/\n/g, '\\n')
                            .replace(/\r/g, '\\r')
                            .replace(/\t/g, '\\t');
                        return `"content": "${escaped}"`;
                    });

                    // Also fix shareableQuote field
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
                    // Store as object, not string - let Express serialize it
                    currentResult = {
                        response: parsedJson, // Send as object
                        isProcessing: false,
                        lastModified: new Date().toISOString(),
                        error: null
                    };
                    logRequest(prompt, parsedJson);
                    return;
                }
            } catch (e) {
                console.error('JSON parse error:', e.message);
                console.error('Failed response sample:', claudeResponse.substring(0, 500));
                // Keep as raw text if not valid JSON
            }

            currentResult = {
                response: claudeResponse, // security.sanitizeInput(claudeResponse),
                isProcessing: false,
                lastModified: new Date().toISOString(),
                error: null
            };

            // This line only executes for non-JSON responses
            logRequest(prompt, claudeResponse);
        } else {
            throw new Error('Invalid response from Claude API');
        }
    } catch (error) {
        console.error('Claude API error:', error.message);
        currentResult = {
            response: 'Error processing request',
            isProcessing: false,
            lastModified: new Date().toISOString(),
            error: process.env.NODE_ENV === 'production' ? 'Processing failed' : error.message
        };
        logRequest(prompt, null, error.message);
    }
}

// Queue for pending requests
let requestQueue = [];
let isCurrentlyProcessing = false;

// Process prompt file with variation for fresh content
async function processPromptFile() {
    // Wait if currently processing another request
    if (isCurrentlyProcessing) {
        return new Promise((resolve) => {
            requestQueue.push(resolve);
        });
    }

    isCurrentlyProcessing = true;

    try {
        if (!fs.existsSync(promptFile)) {
            currentResult = {
                response: 'prompt.txt file not found',
                isProcessing: false,
                lastModified: null,
                error: 'File not found'
            };
            return;
        }

        const basePrompt = fs.readFileSync(promptFile, 'utf8').trim();

        if (!basePrompt) {
            currentResult = {
                response: 'Please add your prompt to prompt.txt',
                isProcessing: false,
                lastModified: null,
                error: null
            };
            return;
        }

        // Add strong variation to ensure completely different content each time
        const timestamp = new Date().toISOString();
        const randomSeed = Math.random().toString(36).substring(7);
        const uniqueId = Date.now() + Math.random();
        const randomNumber = Math.floor(Math.random() * 1000000);

        const prompt = `${basePrompt}

Generation Metadata (use this to ensure uniqueness):
- Generation ID: ${randomSeed}
- Timestamp: ${timestamp}
- Unique Request ID: ${uniqueId}
- Random Seed: ${randomNumber}

CRITICAL INSTRUCTIONS:
1. Generate a story about a COMPLETELY DIFFERENT historical figure than any previous generation
2. Use the random seed above to select a unique figure
3. Vary the time period, region, and theme
4. NEVER repeat the same historical figure
5. Prioritize lesser-known figures to maximize variety`;

        currentResult.isProcessing = true;
        currentResult.response = 'Processing...';
        currentResult.error = null;

        await executeClaudeAPICall(prompt);

    } catch (error) {
        console.error('Error processing prompt:', error);
        currentResult = {
            response: 'Error processing request',
            isProcessing: false,
            lastModified: new Date().toISOString(),
            error: process.env.NODE_ENV === 'production' ? 'Processing failed' : error.message
        };
    } finally {
        isCurrentlyProcessing = false;

        // Process next request in queue if any
        if (requestQueue.length > 0) {
            const nextResolve = requestQueue.shift();
            processPromptFile().then(nextResolve);
        }
    }
}

// Routes
// Public endpoint - get current result (generates new story on each request)
const getResultHandler = async (req, res) => {
    try {
        // Generate a fresh story on every request
        await processPromptFile();
        res.json(currentResult);
    } catch (error) {
        console.error('Error generating story:', error);
        res.status(500).json({
            response: 'Error generating story',
            isProcessing: false,
            lastModified: new Date().toISOString(),
            error: process.env.NODE_ENV === 'production' ? 'Processing failed' : error.message
        });
    }
};
app.get(basePath + '/api/result', getResultHandler);
// Support setups where reverse proxies strip the base path
app.get('/api/result', getResultHandler);

// Protected endpoint - refresh content
const postRefreshHandler = async (req, res) => {
    console.log('Manual refresh triggered');
    try {
        await processPromptFile();
        res.json({ message: 'Refresh triggered', success: true });
    } catch (error) {
        console.error('Refresh error:', error);
        res.status(500).json({ error: 'Failed to refresh content', success: false });
    }
};
app.post(basePath + '/api/refresh',
    security.requireApiKey,
    postRefreshHandler
);
// Support setups where reverse proxies strip the base path
app.post('/api/refresh',
    security.requireApiKey,
    postRefreshHandler
);

app.get(basePath, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(basePath + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initial processing
if (fs.existsSync(promptFile)) {
    processPromptFile();
}

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
