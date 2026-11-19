// Normalize DSH session-list shapes without treating partial pages as a complete inventory.
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const objectEntry = (key, value) => {
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string' || typeof value.sessionId === 'string' || typeof value.session_id === 'string') return value;
  return { ...value, sessionId: key };
};

export function normalizeSessionInventory(input) {
  let cursor = input;
  let source = 'unknown';
  let depth = 0;
  const wrappers = [];
  while (depth < 4 && isRecord(cursor) && !(cursor instanceof Map)) {
    const key = ['sessions', 'items', 'records', 'results'].find(k => cursor[k] !== undefined);
    if (key) {
      wrappers.push(cursor);
      source = (source === 'unknown' ? '' : source + '.') + key;
      cursor = cursor[key];
      depth += 1;
      continue;
    }
    if (cursor.data !== undefined && (Array.isArray(cursor.data) || cursor.data instanceof Map || isRecord(cursor.data))) {
      wrappers.push(cursor);
      source = (source === 'unknown' ? '' : source + '.') + 'data';
      cursor = cursor.data;
      depth += 1;
      continue;
    }
    break;
  }
  let entries;
  if (Array.isArray(cursor)) {
    entries = cursor;
    if (source === 'unknown') source = 'array';
  } else if (cursor instanceof Map) {
    entries = [...cursor].map(([key, value]) => objectEntry(key, value));
    if (source === 'unknown') source = 'map';
  } else if (isRecord(cursor) && Object.keys(cursor).length > 0
    && Object.entries(cursor).every(([, value]) => isRecord(value))) {
    entries = Object.entries(cursor).map(([key, value]) => objectEntry(key, value));
    if (source === 'unknown') source = 'dictionary';
  } else {
    return { supported: false, complete: false, source: 'unknown', records: [], rawCount: 0, reportedTotal: null };
  }
  const metadata = [input, ...wrappers].filter(isRecord);
  const reportedTotal = metadata.map(x => x.total ?? x.totalCount ?? x.pagination?.total)
    .find(x => Number.isSafeInteger(x) && x >= 0) ?? null;
  const paginated = metadata.some(x => x.hasMore === true || x.hasNextPage === true
    || x.pageInfo?.hasNextPage === true || Boolean(x.nextCursor || x.nextPageToken || x.next));
  // Some Host lists contain only loaded/recent sessions. Archive missing routes
  // only when the service explicitly declares its inventory complete.
  const declaredComplete = metadata.some(x => x.complete === true || x.isComplete === true || x.authoritative === true);
  const complete = declaredComplete && !paginated && (reportedTotal === null || reportedTotal <= entries.length);
  return {
    supported: true, complete, source, reportedTotal, rawCount: entries.length,
    records: entries.filter(x => isRecord(x) && typeof (x.id ?? x.sessionId ?? x.session_id) === 'string' && (x.id ?? x.sessionId ?? x.session_id).trim()),
  };
}
