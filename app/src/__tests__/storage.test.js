const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');

const { FileStorage, FirestoreStorage, createStorage } = require('../storage');

// ---------------------------------------------------------------------------
// FileStorage — default filesystem-backed JSON document store
// ---------------------------------------------------------------------------
describe('FileStorage', () => {
    let baseDir;
    let storage;

    beforeEach(async () => {
        baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ihb-storage-'));
        storage = new FileStorage(baseDir);
    });

    afterEach(async () => {
        await fsp.rm(baseDir, { recursive: true, force: true });
    });

    it('round-trips an object through write/read', async () => {
        const value = { name: 'Ashoka', tags: ['maurya', 'edicts'], nested: { ok: true } };
        await storage.write('current-story', value);
        const loaded = await storage.read('current-story', null);
        expect(loaded).toEqual(value);
    });

    it('round-trips an array value (e.g. delivery log)', async () => {
        const value = [{ status: 'sent' }, { status: 'failed' }];
        await storage.write('push-delivery-log', value);
        expect(await storage.read('push-delivery-log', [])).toEqual(value);
    });

    it('returns the fallback when the key does not exist', async () => {
        expect(await storage.read('missing', null)).toBe(null);
        expect(await storage.read('missing', { subscriptions: [] })).toEqual({ subscriptions: [] });
    });

    it('maps a plain key to <baseDir>/<key>.json', async () => {
        await storage.write('push-subscriptions', { subscriptions: [] });
        const expectedPath = path.join(baseDir, 'push-subscriptions.json');
        await expect(fsp.access(expectedPath)).resolves.toBeUndefined();
    });

    it('maps a stories/<date> key to <baseDir>/stories/<date>.json', async () => {
        await storage.write('stories/2026-06-22', { story: { name: 'X' } });
        const expectedPath = path.join(baseDir, 'stories', '2026-06-22.json');
        await expect(fsp.access(expectedPath)).resolves.toBeUndefined();
    });

    it('creates the base directory if missing', async () => {
        await fsp.rm(baseDir, { recursive: true, force: true });
        await storage.write('current-story', { ok: 1 });
        expect(await storage.read('current-story', null)).toEqual({ ok: 1 });
    });

    it('writes pretty-printed JSON (2-space indent)', async () => {
        const value = { story: { name: 'Z', content: 'W' } };
        await storage.write('current-story', value);
        const raw = await fsp.readFile(path.join(baseDir, 'current-story.json'), 'utf8');
        expect(raw).toBe(JSON.stringify(value, null, 2));
    });

    it('throws on malformed JSON rather than returning the fallback', async () => {
        await fsp.writeFile(path.join(baseDir, 'current-story.json'), 'not json {{{');
        await expect(storage.read('current-story', null)).rejects.toThrow();
    });
});

// ---------------------------------------------------------------------------
// FirestoreStorage — Firestore-backed JSON document store (injected client)
// ---------------------------------------------------------------------------
function createFakeFirestore() {
    // Minimal in-memory fake of the Firestore client surface we use.
    const store = new Map(); // `${collection}/${doc}` -> data object
    return {
        store,
        collection(collectionId) {
            return {
                doc(docId) {
                    const key = `${collectionId}/${docId}`;
                    return {
                        collectionId,
                        docId,
                        async get() {
                            const exists = store.has(key);
                            return {
                                exists,
                                data: () => (exists ? store.get(key) : undefined)
                            };
                        },
                        async set(data) {
                            store.set(key, data);
                        }
                    };
                }
            };
        }
    };
}

describe('FirestoreStorage', () => {
    let db;
    let storage;

    beforeEach(() => {
        db = createFakeFirestore();
        storage = new FirestoreStorage(db);
    });

    it('round-trips an object through write/read', async () => {
        const value = { name: 'Ashoka', nested: { ok: true } };
        await storage.write('current-story', value);
        expect(await storage.read('current-story', null)).toEqual(value);
    });

    it('round-trips an array value', async () => {
        const value = [{ a: 1 }, { b: 2 }];
        await storage.write('push-delivery-log', value);
        expect(await storage.read('push-delivery-log', [])).toEqual(value);
    });

    it('returns the fallback when the document does not exist', async () => {
        expect(await storage.read('missing', null)).toBe(null);
        expect(await storage.read('missing', { subscriptions: [] })).toEqual({ subscriptions: [] });
    });

    it('stores plain keys in the state collection', async () => {
        await storage.write('push-subscriptions', { subscriptions: [] });
        expect(db.store.has('ihb-state/push-subscriptions')).toBe(true);
    });

    it('routes stories/<date> keys to the stories collection keyed by date', async () => {
        await storage.write('stories/2026-06-22', { story: { name: 'X' } });
        expect(db.store.has('ihb-stories/2026-06-22')).toBe(true);
        expect(await storage.read('stories/2026-06-22', null)).toEqual({ story: { name: 'X' } });
    });

    it('wraps the payload so array/scalar values are valid Firestore documents', async () => {
        await storage.write('push-delivery-log', [1, 2, 3]);
        // A Firestore document must be a map at the top level.
        expect(db.store.get('ihb-state/push-delivery-log')).toEqual({ value: [1, 2, 3] });
    });
});

// ---------------------------------------------------------------------------
// createStorage — backend selection
// ---------------------------------------------------------------------------
describe('createStorage', () => {
    it('defaults to FileStorage when STORAGE_BACKEND is unset', () => {
        const storage = createStorage({});
        expect(storage).toBeInstanceOf(FileStorage);
    });

    it('defaults to FileStorage for any non-firestore value', () => {
        expect(createStorage({ STORAGE_BACKEND: 'file' })).toBeInstanceOf(FileStorage);
    });

    it('returns FirestoreStorage when STORAGE_BACKEND=firestore', () => {
        const storage = createStorage({ STORAGE_BACKEND: 'firestore' });
        expect(storage).toBeInstanceOf(FirestoreStorage);
    });
});
