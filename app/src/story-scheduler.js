const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');

const runtimeDataDir = path.resolve(__dirname, '../../runtime/data');
const currentStoryPath = path.join(runtimeDataDir, 'current-story.json');
const storiesArchiveDir = path.join(runtimeDataDir, 'stories');
const subscriptionsPath = path.join(runtimeDataDir, 'push-subscriptions.json');
const notificationLedgerPath = path.join(runtimeDataDir, 'push-send-ledger.json');

function getStoryDateKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function createEmptyCurrentResult() {
    return {
        response: 'No daily story has been generated yet',
        isProcessing: false,
        lastModified: null,
        error: null
    };
}

let currentResult = createEmptyCurrentResult();
let requestQueue = [];
let isCurrentlyProcessing = false;

function configurePushNotifications() {
    if (!process.env.PUSH_NOTIFICATION_AUDIENCE) {
        return false;
    }
    return true;
}

function getSubscriptionIdentifier(subscription) {
    return subscription.endpoint;
}

function createSendLedgerKey(storyDateKey, subscriptionIdentifier) {
    return `${storyDateKey}::${subscriptionIdentifier}`;
}

async function ensureRuntimeDataDir() {
    await fsp.mkdir(runtimeDataDir, { recursive: true });
    await fsp.mkdir(storiesArchiveDir, { recursive: true });
}

function getStoryArchivePath(storyDateKey) {
    return path.join(storiesArchiveDir, `${storyDateKey}.json`);
}

function buildStoryAppUrl(storyDateKey) {
    const basePath = process.env.BASE_PATH || '/indianhistorybite';
    const searchParams = new URLSearchParams({ story: storyDateKey });
    return `${basePath}/?${searchParams.toString()}`;
}

function buildNotificationPayload(storyRecord) {
    const teaser = storyRecord.story.shareableQuote || storyRecord.story.title || 'Tap to read today\u2019s Indian History Bite.';

    return {
        title: storyRecord.story.name,
        body: teaser,
        url: buildStoryAppUrl(storyRecord.storyDateKey),
        tag: storyRecord.storyDateKey,
        storyDateKey: storyRecord.storyDateKey
    };
}

async function writeJsonFile(filePath, payload) {
    await ensureRuntimeDataDir();
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
}

async function readJsonFile(filePath, fallbackValue) {
    try {
        const raw = await fsp.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return fallbackValue;
        }
        throw error;
    }
}

function logRequest(prompt, response, error = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        prompt: prompt || null,
        ...(error ? { error } : { response })
    };
    if (error) {
        console.error(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

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
                system: prompt.split('\n\nGeneration Metadata:')[0],
                messages: [{ role: 'user', content: 'Generation Metadata:' + (prompt.split('\n\nGeneration Metadata:')[1] || '') }]
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
        const jsonMatch = claudeResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
            claudeResponse = jsonMatch[1];
        }

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

async function saveDailyStory(storyRecord) {
    await ensureRuntimeDataDir();
    const serialized = JSON.stringify(storyRecord, null, 2);
    await Promise.all([
        fsp.writeFile(currentStoryPath, serialized),
        fsp.writeFile(getStoryArchivePath(storyRecord.storyDateKey), serialized)
    ]);
}

async function loadDailyStoryFromStorage(storyDateKey) {
    const targetPath = storyDateKey ? getStoryArchivePath(storyDateKey) : currentStoryPath;
    return readJsonFile(targetPath, null);
}

async function loadSubscriptions() {
    const data = await readJsonFile(subscriptionsPath, { subscriptions: [] });
    if (!Array.isArray(data.subscriptions)) {
        return { subscriptions: [] };
    }
    return data;
}

async function saveSubscriptions(data) {
    await writeJsonFile(subscriptionsPath, data);
}

async function loadNotificationLedger() {
    const data = await readJsonFile(notificationLedgerPath, { entries: {} });
    if (!data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        return { entries: {} };
    }
    return data;
}

async function saveNotificationLedger(data) {
    await writeJsonFile(notificationLedgerPath, data);
}

function setCurrentResultFromStoryRecord(storyRecord) {
    currentResult = {
        response: storyRecord.story,
        isProcessing: false,
        lastModified: storyRecord.generatedAt,
        error: null,
        storyDateKey: storyRecord.storyDateKey,
        generatedAt: storyRecord.generatedAt,
        notificationSent: Boolean(storyRecord.notificationSent),
        notification: storyRecord.notification || null
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
        const basePrompt = (process.env.PROMPT_TEXT || '').trim();
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
        storyRecord.notification = buildNotificationPayload(storyRecord);

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

async function ensureDailyStoryForDate(storyDateKey = getStoryDateKey()) {
    const storedStory = await loadDailyStoryFromStorage();
    if (storedStory && storedStory.storyDateKey === storyDateKey && storedStory.story) {
        return { storyRecord: storedStory, created: false };
    }

    await generateAndStoreDailyStory({ storyDateKey, notificationSent: false });
    const refreshedStory = await loadDailyStoryFromStorage();
    return { storyRecord: refreshedStory, created: true };
}

function createPushPayload(storyRecord) {
    return JSON.stringify({
        title: 'Indian History Bite',
        body: `${storyRecord.story.name}: ${storyRecord.story.title || 'Today\'s story is ready.'}`,
        storyDateKey: storyRecord.storyDateKey,
        path: process.env.BASE_PATH || '/indianhistorybite',
        quote: storyRecord.story.shareableQuote || ''
    });
}

function isGoneSubscriptionError(error) {
    const statusCode = error && error.statusCode;
    if (statusCode === 404 || statusCode === 410) {
        return true;
    }

    const body = String((error && error.body) || '').toLowerCase();
    return body.includes('invalid') || body.includes('expired') || body.includes('unsubscribed');
}

async function recordLedgerAttempt(ledger, ledgerKey, entry) {
    ledger.entries[ledgerKey] = {
        ...(ledger.entries[ledgerKey] || {}),
        ...entry
    };
    await saveNotificationLedger(ledger);
}

async function sendPushNotification(subscription, payload) {
    return axios.post(subscription.endpoint, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-Notification-Audience': process.env.PUSH_NOTIFICATION_AUDIENCE
        },
        timeout: 15000,
        validateStatus: () => true
    }).then((response) => {
        if (response.status >= 200 && response.status < 300) {
            return { statusCode: response.status };
        }

        const error = new Error(`Push delivery failed with status ${response.status}`);
        error.statusCode = response.status;
        error.body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        throw error;
    });
}

async function sendNotificationsForStory(storyRecord) {
    const pushConfigured = configurePushNotifications();
    const subscriptionsData = await loadSubscriptions();
    const ledger = await loadNotificationLedger();

    if (!pushConfigured) {
        return {
            storyDateKey: storyRecord.storyDateKey,
            pushConfigured: false,
            sent: 0,
            skipped: subscriptionsData.subscriptions.length,
            removed: 0,
            failed: 0,
            totalSubscriptions: subscriptionsData.subscriptions.length,
            results: []
        };
    }

    const payload = createPushPayload(storyRecord);
    const remainingSubscriptions = [];
    const results = [];
    let sent = 0;
    let skipped = 0;
    let removed = 0;
    let failed = 0;

    for (const subscriptionRecord of subscriptionsData.subscriptions) {
        const subscription = subscriptionRecord.subscription || subscriptionRecord;
        const subscriptionIdentifier = getSubscriptionIdentifier(subscription);
        const ledgerKey = createSendLedgerKey(storyRecord.storyDateKey, subscriptionIdentifier);
        const existingEntry = ledger.entries[ledgerKey];

        if (existingEntry && existingEntry.status === 'sent') {
            skipped += 1;
            remainingSubscriptions.push(subscriptionRecord);
            results.push({ subscriptionIdentifier, status: 'skipped' });
            continue;
        }

        try {
            const response = await sendPushNotification(subscription, payload);
            await recordLedgerAttempt(ledger, ledgerKey, {
                storyDateKey: storyRecord.storyDateKey,
                subscriptionIdentifier,
                status: 'sent',
                sentAt: new Date().toISOString(),
                statusCode: response.statusCode
            });
            remainingSubscriptions.push(subscriptionRecord);
            sent += 1;
            results.push({ subscriptionIdentifier, status: 'sent', statusCode: response.statusCode });
        } catch (error) {
            if (isGoneSubscriptionError(error)) {
                removed += 1;
                results.push({
                    subscriptionIdentifier,
                    status: 'removed',
                    statusCode: error.statusCode,
                    error: error.body || error.message
                });
                continue;
            }

            failed += 1;
            await recordLedgerAttempt(ledger, ledgerKey, {
                storyDateKey: storyRecord.storyDateKey,
                subscriptionIdentifier,
                status: 'failed',
                lastAttemptAt: new Date().toISOString(),
                statusCode: error.statusCode || null,
                error: error.body || error.message
            });
            remainingSubscriptions.push(subscriptionRecord);
            results.push({
                subscriptionIdentifier,
                status: 'failed',
                statusCode: error.statusCode,
                error: error.body || error.message
            });
        }
    }

    subscriptionsData.subscriptions = remainingSubscriptions;
    await saveSubscriptions(subscriptionsData);

    return {
        storyDateKey: storyRecord.storyDateKey,
        pushConfigured: true,
        sent,
        skipped,
        removed,
        failed,
        totalSubscriptions: subscriptionsData.subscriptions.length,
        results
    };
}

async function runDailyStoryJob(options = {}) {
    const storyDateKey = options.storyDateKey || getStoryDateKey();
    const { storyRecord, created } = await ensureDailyStoryForDate(storyDateKey);
    const notificationSummary = await sendNotificationsForStory(storyRecord);
    const notificationSent = notificationSummary.pushConfigured ? notificationSummary.failed === 0 : false;

    if (storyRecord.notificationSent !== notificationSent) {
        storyRecord.notificationSent = notificationSent;
        await saveDailyStory(storyRecord);
        setCurrentResultFromStoryRecord(storyRecord);
    }

    return {
        storyDateKey,
        storyCreated: created,
        notificationSummary,
        storyRecord
    };
}

async function upsertPushSubscription(subscription) {
    const subscriptionIdentifier = getSubscriptionIdentifier(subscription);
    const subscriptionsData = await loadSubscriptions();
    const now = new Date().toISOString();
    const nextSubscriptions = subscriptionsData.subscriptions.filter((item) => {
        const existingSubscription = item.subscription || item;
        return getSubscriptionIdentifier(existingSubscription) !== subscriptionIdentifier;
    });

    nextSubscriptions.push({
        subscription,
        createdAt: now,
        updatedAt: now,
        active: true
    });

    subscriptionsData.subscriptions = nextSubscriptions;
    await saveSubscriptions(subscriptionsData);
    return { subscriptionIdentifier, count: nextSubscriptions.length };
}

async function removePushSubscription(subscription) {
    const subscriptionIdentifier = getSubscriptionIdentifier(subscription);
    const subscriptionsData = await loadSubscriptions();
    const nextSubscriptions = subscriptionsData.subscriptions.filter((item) => {
        const existingSubscription = item.subscription || item;
        return getSubscriptionIdentifier(existingSubscription) !== subscriptionIdentifier;
    });
    const removed = nextSubscriptions.length !== subscriptionsData.subscriptions.length;
    subscriptionsData.subscriptions = nextSubscriptions;
    await saveSubscriptions(subscriptionsData);
    return { subscriptionIdentifier, removed, count: nextSubscriptions.length };
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

module.exports = {
    createEmptyCurrentResult,
    currentStoryPath,
    getCurrentResult: () => currentResult,
    getStoryDateKey,
    getSubscriptionIdentifier,
    createSendLedgerKey,
    loadDailyStoryFromStorage,
    setCurrentResultFromStoryRecord,
    setCurrentResultError,
    generateAndStoreDailyStory,
    ensureDailyStoryForDate,
    initializeCurrentStory,
    runDailyStoryJob,
    upsertPushSubscription,
    removePushSubscription,
    loadSubscriptions,
    loadNotificationLedger
};
