const DATABASE_NAME = "tempo-trends";
const DATABASE_VERSION = 1;
const META_STORE = "spaces";
const POINT_STORE = "points";
const SERIES = ["marketValue", "restingHeartRate", "steps", "sleep", "nutrition", "volume"];

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: "namespace" });
      if (!database.objectStoreNames.contains(POINT_STORE)) {
        const points = database.createObjectStore(POINT_STORE, { keyPath: ["namespace", "series", "date"] });
        points.createIndex("namespace", "namespace", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the trend cache."));
  });
}

function deleteNamespacePoints(store, namespace) {
  return new Promise((resolve, reject) => {
    const request = store.index("namespace").openKeyCursor(IDBKeyRange.only(namespace));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve(); return; }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error("Could not clear cached trend points."));
  });
}

export function mergeTrendSeries(current = {}, delta = {}) {
  const next = Object.fromEntries(SERIES.map(series => [series, [...(current[series] || [])]]));
  if (delta.reset) SERIES.forEach(series => { next[series] = []; });
  for (const [series, dates] of Object.entries(delta.deleted || {})) {
    const removed = new Set(dates || []);
    next[series] = (next[series] || []).filter(point => !removed.has(point.date));
  }
  for (const [series, points] of Object.entries(delta.changes || {})) {
    const byDate = new Map((next[series] || []).map(point => [point.date, point]));
    for (const point of points || []) byDate.set(point.date, point);
    next[series] = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  }
  return next;
}

export async function activateTrendNamespace(namespace) {
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, POINT_STORE], "readwrite");
  const meta = transaction.objectStore(META_STORE);
  const points = transaction.objectStore(POINT_STORE);
  const namespaces = await requestResult(meta.getAllKeys());
  for (const stored of namespaces) {
    if (stored === namespace) continue;
    meta.delete(stored);
    await deleteNamespacePoints(points, stored);
  }
  await transactionDone(transaction);
  database.close();
}

export async function readTrendCache(namespace) {
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, POINT_STORE], "readonly");
  const metadata = await requestResult(transaction.objectStore(META_STORE).get(namespace));
  const records = await requestResult(transaction.objectStore(POINT_STORE).index("namespace").getAll(namespace));
  await transactionDone(transaction);
  database.close();
  if (!metadata) return null;
  const series = Object.fromEntries(SERIES.map(name => [name, []]));
  for (const record of records) (series[record.series] ||= []).push(record.point);
  SERIES.forEach(name => series[name].sort((left, right) => left.date.localeCompare(right.date)));
  return { cursor: metadata.cursor, meta: metadata.meta, series };
}

export async function applyTrendDelta(namespace, delta) {
  const database = await openDatabase();
  const transaction = database.transaction([META_STORE, POINT_STORE], "readwrite");
  const meta = transaction.objectStore(META_STORE);
  const points = transaction.objectStore(POINT_STORE);
  if (delta.reset) await deleteNamespacePoints(points, namespace);
  for (const [series, dates] of Object.entries(delta.deleted || {})) {
    for (const date of dates || []) points.delete([namespace, series, date]);
  }
  for (const [series, changes] of Object.entries(delta.changes || {})) {
    for (const point of changes || []) points.put({ namespace, series, date: point.date, point });
  }
  meta.put({ namespace, cursor: delta.cursor, meta: delta.meta });
  await transactionDone(transaction);
  database.close();
  return readTrendCache(namespace);
}
