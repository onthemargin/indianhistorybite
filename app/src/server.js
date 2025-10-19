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
const security = require('./security');

const app = express();
const port = process.env.PORT || 3001;
const basePath = process.env.BASE_PATH || '/indianhistorybite';

// Runtime directories
const runtimeDir = process.env.RUNTIME_DIR || path.join(__dirname, '../../../runtime');
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
        // In production, always require origin header
        if (process.env.NODE_ENV === 'production' && !origin) {
            return callback(new Error('Not allowed by CORS - origin required'));
        }

        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : [];

        // Allow if in allowedOrigins, or no origin in development only
        if (allowedOrigins.includes(origin) || (!origin && process.env.NODE_ENV !== 'production')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    maxAge: 86400 // Cache preflight requests for 24 hours
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(basePath, express.static(__dirname, { maxAge: '1h' }));

// Simple logging
function logRequest(prompt, response, error = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `
=== ${timestamp} ===
PROMPT: ${prompt ? prompt.substring(0, 200) : ''}
${error ? `ERROR: ${error}` : `RESPONSE: [LOGGED]`}
==================================================

`;
    try {
        fs.appendFileSync(logFile, logEntry);
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
                const parsedJson = JSON.parse(claudeResponse);
                if (parsedJson.name && parsedJson.content) {
                    claudeResponse = JSON.stringify(parsedJson);
                }
            } catch (e) {
                // Keep as raw text if not valid JSON
            }
            
            currentResult = {
                response: security.sanitizeInput(claudeResponse),
                isProcessing: false,
                lastModified: new Date().toISOString(),
                error: null
            };
            
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

// Process prompt file with variation for fresh content
async function processPromptFile() {
    // Allow concurrent requests to queue
    if (currentResult.isProcessing) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (currentResult.isProcessing) return; // Still processing, return cached
    }
    
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
    }
}

// Routes
// Public endpoint - get current result (generates new story on each request)
app.get(basePath + '/api/result', async (req, res) => {
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
});

// Protected endpoint - refresh content
app.post(basePath + '/api/refresh', 
    security.rateLimiters.refresh,
    security.requireApiKey,
    async (req, res) => {
        console.log('Manual refresh triggered');
        try {
            await processPromptFile();
            res.json({ message: 'Refresh triggered', success: true });
        } catch (error) {
            console.error('Refresh error:', error);
            res.status(500).json({ error: 'Failed to refresh content', success: false });
        }
    }
);

app.get(basePath, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(basePath + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Initial processing
if (fs.existsSync(promptFile)) {
    processPromptFile();
}

// Error handling middleware (must be last)
app.use(security.secureErrorHandler);

// Start server
const server = app.listen(port, '0.0.0.0', () => {
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