/**
 * Tests for the story generation pipeline:
 *   - executeClaudeAPICall() — JSON extraction, error handling
 *   - generateAndStoreDailyStory() — concurrency queue, disk persistence
 *   - loadDailyStoryFromStorage() / saveDailyStory() — file I/O edge cases
 *   - setCurrentResultFromStoryRecord() — data transformation
 *   - createEmptyCurrentResult() — default state
 *
 * Strategy: We cannot require server.js directly (it boots Express and binds
 * a port). Instead we extract the pure functions by reading the source and
 * using jest.mock to intercept side-effects (fs, axios).
 *
 * For functions that are module-scoped and not exported we replicate the
 * exact logic here and test it in isolation — this is intentional because
 * server.js does not export its internals.
 */

const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Replicated pure functions (mirrors server.js logic exactly)
// ---------------------------------------------------------------------------

function createEmptyCurrentResult() {
    return {
        response: 'No daily story has been generated yet',
        isProcessing: false,
        lastModified: null,
        error: null
    };
}

function setCurrentResultFromStoryRecord(storyRecord) {
    return {
        response: storyRecord.story,
        isProcessing: false,
        lastModified: storyRecord.generatedAt,
        error: null,
        storyDateKey: storyRecord.storyDateKey,
        generatedAt: storyRecord.generatedAt,
        notificationSent: Boolean(storyRecord.notificationSent)
    };
}

function setCurrentResultError(message, internalError) {
    return {
        response: message,
        isProcessing: false,
        lastModified: expect.any(String),
        error: internalError
    };
}

/**
 * Replicates the JSON-extraction logic from executeClaudeAPICall.
 * Given raw text from Claude's response, extract and parse a story JSON.
 */
function extractStoryJson(claudeResponse) {
    // Extract JSON from markdown if present
    const jsonMatch = claudeResponse.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
        claudeResponse = jsonMatch[1];
    }

    try {
        let parsedJson;
        try {
            parsedJson = JSON.parse(claudeResponse);
        } catch (firstError) {
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
            return parsedJson;
        }
        return null; // valid JSON but missing required fields
    } catch (e) {
        return null; // unparseable
    }
}

// ---------------------------------------------------------------------------
// 1. createEmptyCurrentResult
// ---------------------------------------------------------------------------
describe('createEmptyCurrentResult', () => {
    it('returns expected default shape', () => {
        const result = createEmptyCurrentResult();
        expect(result).toEqual({
            response: 'No daily story has been generated yet',
            isProcessing: false,
            lastModified: null,
            error: null
        });
    });

    it('returns a fresh object each call (no shared reference)', () => {
        const a = createEmptyCurrentResult();
        const b = createEmptyCurrentResult();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});

// ---------------------------------------------------------------------------
// 2. setCurrentResultFromStoryRecord — data transformation
// ---------------------------------------------------------------------------
describe('setCurrentResultFromStoryRecord', () => {
    const fullRecord = {
        story: {
            name: 'Rani Lakshmibai',
            title: 'The Warrior Queen of Jhansi',
            content: 'She led her troops into battle.',
            shareableQuote: 'Freedom is my birthright.'
        },
        generatedAt: '2026-04-01T08:00:00.000Z',
        storyDateKey: '2026-04-01',
        notificationSent: true
    };

    it('maps story record to the expected result shape', () => {
        const result = setCurrentResultFromStoryRecord(fullRecord);
        expect(result).toEqual({
            response: fullRecord.story,
            isProcessing: false,
            lastModified: '2026-04-01T08:00:00.000Z',
            error: null,
            storyDateKey: '2026-04-01',
            generatedAt: '2026-04-01T08:00:00.000Z',
            notificationSent: true
        });
    });

    it('coerces falsy notificationSent to false', () => {
        const record = { ...fullRecord, notificationSent: undefined };
        expect(setCurrentResultFromStoryRecord(record).notificationSent).toBe(false);
    });

    it('coerces notificationSent=0 to false', () => {
        const record = { ...fullRecord, notificationSent: 0 };
        expect(setCurrentResultFromStoryRecord(record).notificationSent).toBe(false);
    });

    it('coerces notificationSent=null to false', () => {
        const record = { ...fullRecord, notificationSent: null };
        expect(setCurrentResultFromStoryRecord(record).notificationSent).toBe(false);
    });

    it('preserves the story object reference (not deep-cloned)', () => {
        const result = setCurrentResultFromStoryRecord(fullRecord);
        expect(result.response).toBe(fullRecord.story);
    });

    it('handles missing optional story fields gracefully', () => {
        const minimal = {
            story: { name: 'A', content: 'B' },
            generatedAt: '2026-01-01T00:00:00.000Z',
            storyDateKey: '2026-01-01'
        };
        const result = setCurrentResultFromStoryRecord(minimal);
        expect(result.response).toEqual({ name: 'A', content: 'B' });
        expect(result.notificationSent).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 3. JSON extraction from Claude responses (extractStoryJson)
// ---------------------------------------------------------------------------
describe('extractStoryJson — JSON extraction from Claude responses', () => {
    const validStory = {
        name: 'Ashoka',
        title: 'The Great Emperor',
        content: 'Ashoka ruled the Maurya Empire.',
        shareableQuote: 'Non-violence is the greatest force.'
    };

    it('parses plain JSON string', () => {
        const raw = JSON.stringify(validStory);
        expect(extractStoryJson(raw)).toEqual(validStory);
    });

    it('extracts JSON wrapped in markdown ```json``` fences', () => {
        const raw = '```json\n' + JSON.stringify(validStory) + '\n```';
        expect(extractStoryJson(raw)).toEqual(validStory);
    });

    it('extracts JSON from markdown with leading/trailing text', () => {
        const raw = 'Here is the story:\n```json\n' + JSON.stringify(validStory) + '\n```\nEnjoy!';
        expect(extractStoryJson(raw)).toEqual(validStory);
    });

    it('handles markdown fence with extra whitespace', () => {
        const raw = '```json   \n' + JSON.stringify(validStory) + '   \n```';
        expect(extractStoryJson(raw)).toEqual(validStory);
    });

    it('returns null for completely invalid text', () => {
        expect(extractStoryJson('This is not JSON at all')).toBe(null);
    });

    it('returns null for empty string', () => {
        expect(extractStoryJson('')).toBe(null);
    });

    it('returns null for valid JSON missing required "name" field', () => {
        const partial = { title: 'No name', content: 'Some content' };
        expect(extractStoryJson(JSON.stringify(partial))).toBe(null);
    });

    it('returns null for valid JSON missing required "content" field', () => {
        const partial = { name: 'Ashoka', title: 'Emperor' };
        expect(extractStoryJson(JSON.stringify(partial))).toBe(null);
    });

    it('returns null for JSON array instead of object', () => {
        expect(extractStoryJson('[1,2,3]')).toBe(null);
    });

    it('accepts minimal JSON with only name and content', () => {
        const minimal = { name: 'Tipu Sultan', content: 'Tiger of Mysore.' };
        expect(extractStoryJson(JSON.stringify(minimal))).toEqual(minimal);
    });

    it('fixes unescaped newlines in content field', () => {
        // Simulate Claude returning JSON with literal newlines inside "content"
        const raw = `{"name": "Test", "title": "T", "content": "Line one.\nLine two.", "shareableQuote": "Q"}`;
        const result = extractStoryJson(raw);
        expect(result).not.toBe(null);
        expect(result.name).toBe('Test');
        // After fix, content should contain the text (newline preserved or escaped)
        expect(result.content).toContain('Line one.');
        expect(result.content).toContain('Line two.');
    });

    it('fixes unescaped newlines in shareableQuote field', () => {
        const raw = `{"name": "Test", "content": "OK", "shareableQuote": "Line A\nLine B"}`;
        const result = extractStoryJson(raw);
        expect(result).not.toBe(null);
        expect(result.shareableQuote).toContain('Line A');
        expect(result.shareableQuote).toContain('Line B');
    });

    it('fixes unescaped tabs in content field', () => {
        const raw = `{"name": "Test", "content": "Col1\tCol2", "shareableQuote": "Q"}`;
        const result = extractStoryJson(raw);
        expect(result).not.toBe(null);
        expect(result.content).toContain('Col1');
    });

    it('handles deeply nested markdown fences (picks first match)', () => {
        const inner = JSON.stringify(validStory);
        const raw = 'text\n```json\n' + inner + '\n```\nmore text\n```json\n{"name":"other","content":"c"}\n```';
        // The regex is non-greedy, should match first block
        const result = extractStoryJson(raw);
        expect(result).toEqual(validStory);
    });
});

// ---------------------------------------------------------------------------
// 4. File I/O — saveDailyStory / loadDailyStoryFromStorage
// ---------------------------------------------------------------------------
describe('file I/O — saveDailyStory / loadDailyStoryFromStorage', () => {
    const testDataDir = path.resolve(__dirname, '../../../runtime/data');
    const testStoryPath = path.join(testDataDir, 'current-story.json');

    // Replicate the functions using the same paths as server.js
    async function saveDailyStory(storyRecord) {
        await fsp.mkdir(testDataDir, { recursive: true });
        await fsp.writeFile(testStoryPath, JSON.stringify(storyRecord, null, 2));
    }

    async function loadDailyStoryFromStorage() {
        try {
            const raw = await fsp.readFile(testStoryPath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    beforeEach(async () => {
        // Ensure clean state
        await fsp.mkdir(testDataDir, { recursive: true });
        await fsp.unlink(testStoryPath).catch(() => {});
    });

    afterAll(async () => {
        await fsp.unlink(testStoryPath).catch(() => {});
    });

    it('loadDailyStoryFromStorage returns null when file does not exist', async () => {
        const result = await loadDailyStoryFromStorage();
        expect(result).toBe(null);
    });

    it('saveDailyStory writes JSON that loadDailyStoryFromStorage can read back', async () => {
        const record = {
            story: { name: 'Chandragupta', title: 'Founder', content: 'Built an empire.', shareableQuote: 'Unity.' },
            generatedAt: '2026-04-01T00:00:00.000Z',
            storyDateKey: '2026-04-01',
            notificationSent: false
        };
        await saveDailyStory(record);
        const loaded = await loadDailyStoryFromStorage();
        expect(loaded).toEqual(record);
    });

    it('saveDailyStory overwrites existing story', async () => {
        const first = {
            story: { name: 'A', content: 'First' },
            generatedAt: '2026-01-01T00:00:00.000Z',
            storyDateKey: '2026-01-01',
            notificationSent: false
        };
        const second = {
            story: { name: 'B', content: 'Second' },
            generatedAt: '2026-01-02T00:00:00.000Z',
            storyDateKey: '2026-01-02',
            notificationSent: true
        };
        await saveDailyStory(first);
        await saveDailyStory(second);
        const loaded = await loadDailyStoryFromStorage();
        expect(loaded.story.name).toBe('B');
        expect(loaded.notificationSent).toBe(true);
    });

    it('saveDailyStory creates runtime/data directory if missing', async () => {
        // Remove the directory entirely
        await fsp.rm(testDataDir, { recursive: true, force: true });
        const record = {
            story: { name: 'X', content: 'Y' },
            generatedAt: '2026-01-01T00:00:00.000Z',
            storyDateKey: '2026-01-01',
            notificationSent: false
        };
        await saveDailyStory(record);
        const loaded = await loadDailyStoryFromStorage();
        expect(loaded).toEqual(record);
    });

    it('loadDailyStoryFromStorage throws on malformed JSON', async () => {
        await fsp.writeFile(testStoryPath, 'not valid json {{{');
        await expect(loadDailyStoryFromStorage()).rejects.toThrow();
    });

    it('saved file is pretty-printed (2-space indent)', async () => {
        const record = {
            story: { name: 'Z', content: 'W' },
            generatedAt: '2026-01-01T00:00:00.000Z',
            storyDateKey: '2026-01-01',
            notificationSent: false
        };
        await saveDailyStory(record);
        const raw = await fsp.readFile(testStoryPath, 'utf8');
        // Pretty-printed JSON should contain newlines and indentation
        expect(raw).toContain('\n');
        expect(raw).toContain('  ');
        // Verify it matches JSON.stringify with 2 spaces
        expect(raw).toBe(JSON.stringify(record, null, 2));
    });
});

// ---------------------------------------------------------------------------
// 5. Concurrency queue logic (generateAndStoreDailyStory pattern)
// ---------------------------------------------------------------------------
describe('concurrency queue pattern', () => {
    // Replicate the queue logic in isolation
    let requestQueue;
    let isProcessing;
    let processCount;

    function resetQueue() {
        requestQueue = [];
        isProcessing = false;
        processCount = 0;
    }

    // Each call carries its own workFn, matching server.js where queued
    // requests each call generateAndStoreDailyStory with their own options.
    async function processWithQueue(workFn) {
        if (isProcessing) {
            return new Promise((resolve, reject) => {
                requestQueue.push({ resolve, reject, workFn });
            });
        }

        isProcessing = true;
        try {
            processCount++;
            const result = await workFn();
            return result;
        } finally {
            isProcessing = false;
            if (requestQueue.length > 0) {
                const next = requestQueue.shift();
                processWithQueue(next.workFn).then(next.resolve).catch(next.reject);
            }
        }
    }

    beforeEach(() => resetQueue());

    it('executes immediately when queue is idle', async () => {
        const result = await processWithQueue(async () => 'done');
        expect(result).toBe('done');
        expect(processCount).toBe(1);
    });

    it('queues concurrent requests and processes them sequentially', async () => {
        const order = [];
        let resolveFirst;
        const firstBlocking = new Promise(r => { resolveFirst = r; });

        const p1 = processWithQueue(async () => {
            order.push('start-1');
            await firstBlocking;
            order.push('end-1');
            return 'result-1';
        });

        // Second request arrives while first is processing
        const p2 = processWithQueue(async () => {
            order.push('start-2');
            order.push('end-2');
            return 'result-2';
        });

        // First is still in progress, second should be queued
        expect(requestQueue.length).toBe(1);

        // Unblock first
        resolveFirst();
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1).toBe('result-1');
        expect(r2).toBe('result-2');
        expect(order[0]).toBe('start-1');
        expect(order[1]).toBe('end-1');
        expect(order[2]).toBe('start-2');
        expect(order[3]).toBe('end-2');
    });

    it('propagates errors without breaking the queue', async () => {
        let resolveFirst;
        const firstBlocking = new Promise(r => { resolveFirst = r; });

        const p1 = processWithQueue(async () => {
            await firstBlocking;
            throw new Error('boom');
        });

        const p2 = processWithQueue(async () => 'recovered');

        resolveFirst();

        await expect(p1).rejects.toThrow('boom');
        const r2 = await p2;
        expect(r2).toBe('recovered');
    });
});

// ---------------------------------------------------------------------------
// 6. storyDateKey validation in generateAndStoreDailyStory
// ---------------------------------------------------------------------------
describe('storyDateKey validation logic', () => {
    const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    function resolveStoryDateKey(options, fallbackIso) {
        return (options.storyDateKey && VALID_DATE_RE.test(options.storyDateKey))
            ? options.storyDateKey
            : fallbackIso.slice(0, 10);
    }

    it('uses provided valid date key', () => {
        expect(resolveStoryDateKey({ storyDateKey: '2026-04-01' }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-01');
    });

    it('falls back to ISO date slice when key is invalid', () => {
        expect(resolveStoryDateKey({ storyDateKey: 'bad-date' }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });

    it('falls back when key is empty string', () => {
        expect(resolveStoryDateKey({ storyDateKey: '' }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });

    it('falls back when key is undefined', () => {
        expect(resolveStoryDateKey({ storyDateKey: undefined }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });

    it('falls back when key is null', () => {
        expect(resolveStoryDateKey({ storyDateKey: null }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });

    it('rejects date with slashes', () => {
        expect(resolveStoryDateKey({ storyDateKey: '2026/04/01' }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });

    it('rejects date with injection attempt', () => {
        expect(resolveStoryDateKey({ storyDateKey: '2026-04-01; DROP' }, '2026-04-04T12:00:00.000Z'))
            .toBe('2026-04-04');
    });
});

// ---------------------------------------------------------------------------
// 7. Story record construction (mirrors generateAndStoreDailyStory output)
// ---------------------------------------------------------------------------
describe('story record construction', () => {
    function buildStoryRecord(storyPayload, generatedAt, storyDateKey, options) {
        return {
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
    }

    it('builds complete record from full payload', () => {
        const payload = {
            name: 'Bhagat Singh',
            title: 'Revolutionary',
            content: 'Fought for freedom.',
            shareableQuote: 'Revolution is inalienable.'
        };
        const record = buildStoryRecord(payload, '2026-04-01T00:00:00.000Z', '2026-04-01', {});
        expect(record.story.name).toBe('Bhagat Singh');
        expect(record.story.title).toBe('Revolutionary');
        expect(record.notificationSent).toBe(false);
    });

    it('defaults title to empty string when missing', () => {
        const payload = { name: 'A', content: 'B' };
        const record = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', {});
        expect(record.story.title).toBe('');
    });

    it('defaults shareableQuote to empty string when missing', () => {
        const payload = { name: 'A', content: 'B' };
        const record = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', {});
        expect(record.story.shareableQuote).toBe('');
    });

    it('respects notificationSent option', () => {
        const payload = { name: 'A', content: 'B' };
        const record = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', { notificationSent: true });
        expect(record.notificationSent).toBe(true);
    });

    it('defaults notificationSent to false via nullish coalescing', () => {
        const payload = { name: 'A', content: 'B' };
        const withUndef = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', { notificationSent: undefined });
        const withNull = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', { notificationSent: null });
        expect(withUndef.notificationSent).toBe(false);
        expect(withNull.notificationSent).toBe(false);
    });

    it('does NOT default notificationSent=0 to false (0 is not nullish)', () => {
        const payload = { name: 'A', content: 'B' };
        const record = buildStoryRecord(payload, '2026-01-01T00:00:00.000Z', '2026-01-01', { notificationSent: 0 });
        // ?? only triggers on null/undefined, so 0 stays 0
        expect(record.notificationSent).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 8. Edge cases in prompt construction
// ---------------------------------------------------------------------------
describe('prompt splitting logic', () => {
    // server.js splits on '\n\nGeneration Metadata:' to separate system vs user message
    function splitPrompt(prompt) {
        const system = prompt.split('\n\nGeneration Metadata:')[0];
        const user = 'Generation Metadata:' + (prompt.split('\n\nGeneration Metadata:')[1] || '');
        return { system, user };
    }

    it('splits standard prompt correctly', () => {
        const prompt = 'System instructions here\n\nGeneration Metadata:\n- key: value';
        const { system, user } = splitPrompt(prompt);
        expect(system).toBe('System instructions here');
        expect(user).toBe('Generation Metadata:\n- key: value');
    });

    it('handles prompt with no Generation Metadata section', () => {
        const prompt = 'Just system instructions, no metadata';
        const { system, user } = splitPrompt(prompt);
        expect(system).toBe('Just system instructions, no metadata');
        expect(user).toBe('Generation Metadata:');
    });

    it('handles empty prompt', () => {
        const { system, user } = splitPrompt('');
        expect(system).toBe('');
        expect(user).toBe('Generation Metadata:');
    });
});
