const path = require('path');
const fsp = require('fs/promises');

// Pluggable JSON-document storage.
//
// All persistent state is a small JSON document addressed by a logical key:
//   current-story, push-subscriptions, push-send-ledger, push-delivery-log,
//   and stories/<YYYY-MM-DD> for the per-day archive.
//
// FileStorage (default) writes those documents under runtime/data/ exactly as
// the app always has, so existing behaviour and tests are unchanged.
// FirestoreStorage persists them in Firestore so they survive Cloud Run
// instance recycles and are shared across instances. Select the backend with
// the STORAGE_BACKEND environment variable.

const STORIES_PREFIX = 'stories/';

// ---------------------------------------------------------------------------
// Filesystem backend
// ---------------------------------------------------------------------------
class FileStorage {
    constructor(baseDir) {
        this.baseDir = baseDir;
    }

    keyToPath(key) {
        if (key.startsWith(STORIES_PREFIX)) {
            return path.join(this.baseDir, 'stories', `${key.slice(STORIES_PREFIX.length)}.json`);
        }
        return path.join(this.baseDir, `${key}.json`);
    }

    async read(key, fallback) {
        const filePath = this.keyToPath(key);
        try {
            const raw = await fsp.readFile(filePath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return fallback;
            }
            throw error;
        }
    }

    async write(key, value) {
        const filePath = this.keyToPath(key);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
    }
}

// ---------------------------------------------------------------------------
// Firestore backend
// ---------------------------------------------------------------------------
// A Firestore document must be a map at the top level, so every value is
// wrapped as { value: <payload> } to support arrays and scalars uniformly.
class FirestoreStorage {
    constructor(db, options = {}) {
        this.db = db;
        this.stateCollection = options.stateCollection || 'ihb-state';
        this.storiesCollection = options.storiesCollection || 'ihb-stories';
    }

    keyToDocRef(key) {
        if (key.startsWith(STORIES_PREFIX)) {
            return this.db.collection(this.storiesCollection).doc(key.slice(STORIES_PREFIX.length));
        }
        return this.db.collection(this.stateCollection).doc(key);
    }

    async read(key, fallback) {
        const snapshot = await this.keyToDocRef(key).get();
        if (!snapshot.exists) {
            return fallback;
        }
        const data = snapshot.data();
        return data && 'value' in data ? data.value : fallback;
    }

    async write(key, value) {
        await this.keyToDocRef(key).set({ value });
    }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------
function defaultBaseDir() {
    return path.resolve(__dirname, '../../runtime/data');
}

function createStorage(env = process.env) {
    if (env.STORAGE_BACKEND === 'firestore') {
        // Lazy-require so the dependency is only needed when actually selected.
        const { Firestore } = require('@google-cloud/firestore');
        const settings = {};
        if (env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT) {
            settings.projectId = env.FIRESTORE_PROJECT || env.GOOGLE_CLOUD_PROJECT;
        }
        if (env.FIRESTORE_DATABASE) {
            settings.databaseId = env.FIRESTORE_DATABASE;
        }
        return new FirestoreStorage(new Firestore(settings));
    }
    return new FileStorage(env.RUNTIME_DATA_DIR || defaultBaseDir());
}

module.exports = { FileStorage, FirestoreStorage, createStorage };
