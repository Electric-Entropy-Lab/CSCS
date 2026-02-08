class LocalFileSystem {
    constructor() {
        this.sessionId = null;
        this.isPersistent = false;
        this.bufferSize = 100;
        this.initPromise = this.initStorage();
    }
    async initStorage() {
        if ('showDirectoryPicker' in window) {
            try {
                this.directoryHandle = await window.showDirectoryPicker({
                    id: 'cscs-data',
                    mode: 'readwrite'
                });
                this.isPersistent = true;
                console.log('CSCS: Zapis na dysk zainicjalizowany');
                return true;
            } catch (err) {
                console.warn('CSCS: Użytkownik anulował wybór folderu, używam IndexedDB');
            }
        }
        return this.initIndexedDB();
    }
    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('CSCS_Database', 1);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('session_data')) {
                    db.createObjectStore('session_data', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('aggregates')) {
                    db.createObjectStore('aggregates', { keyPath: 'timestamp' });
                }
                if (!db.objectStoreNames.contains('exports')) {
                    db.createObjectStore('exports', { keyPath: 'timestamp' });
                }
            };
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('CSCS: IndexedDB zainicjalizowane');
                resolve(true);
            };
            request.onerror = (event) => {
                console.error('CSCS: Błąd IndexedDB', event);
                reject(event);
            };
        });
    }
    async saveRecord(type, data) {
        await this.initPromise;
        if (!this.buffer) this.buffer = [];
        this.buffer.push({ type, timestamp: Date.now(), ...data });
        if (this.buffer.length >= this.bufferSize) {
            await this.flushBuffer();
        }
        const key = `cscs_latest_${type}`;
        localStorage.setItem(key, JSON.stringify(data));
        return { success: true, buffered: this.buffer.length };
    }
    async flushBuffer() {
        if (!this.buffer || this.buffer.length === 0) return;
        const records = [...this.buffer];
        this.buffer = [];

        if (this.isPersistent && this.directoryHandle) {
            try {
                const date = new Date().toISOString().split('T')[0];
                const dir = await this.directoryHandle.getDirectoryHandle(date, { create: true });
                const fileName = `session_${this.sessionId}_${Date.now()}.json`;
                const fileHandle = await dir.getFileHandle(fileName, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(JSON.stringify(records, null, 2));
                await writable.close();
                console.log('CSCS: Zapisano bufor na dysk');
            } catch (err) {
                console.error('CSCS: Błąd zapisu na dysk', err);
                await this.saveToIndexedDB(records);
            }
        } else {
            await this.saveToIndexedDB(records);
        }
    }
    async saveToIndexedDB(records) {
        if (!this.db) return;
        const tx = this.db.transaction(['session_data'], 'readwrite');
        const store = tx.objectStore('session_data');
        records.forEach(record => {
            store.add({ ...record, id: `${this.sessionId}_${Date.now()}_${Math.random()}` });
        });
        return new Promise((resolve) => {
            tx.oncomplete = () => resolve();
        });
    }
    setSessionId(id) {
        this.sessionId = id;
    }
    async generateDownload(data) {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const filename = `cscs_export_${this.sessionId || 'unknown'}_${Date.now()}.json`;
        return { url, filename };
    }
}
const FileSystem = new LocalFileSystem();
