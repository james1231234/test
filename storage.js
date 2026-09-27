/**
 * Role 4 handoff: all exports return Promises and reject with a friendly Error.
 * getProfile() / saveProfile(patch) -> Profile (save merges supplied fields).
 * listEvents() -> Event[]; addEvent(input = {}) / updateEvent(id, patch = {}) -> Event.
 * deleteEvent(id) -> boolean; listMedications() -> Medication[].
 * addMedication(input = {}) / updateMedication(id, patch = {}) -> Medication.
 * deleteMedication(id) -> boolean; savePhoto(file: Blob) -> string ID.
 * getPhotoBlob(id) -> Blob|null; startNewRecord() -> void.
 * Updates preserve IDs, displayNumber, and event createdAt. Lists use stored order;
 * integration sorts by occurredAt || createdAt and formats missing data honestly.
 * Empty names/photoIds/dates remain empty/null: UI must label incomplete cards.
 * Completion dates are supplied by the UI (local YYYY-MM-DD), never guessed here.
 * Save a photo BEFORE attaching its returned ID to a medication. Failed photo
 * saves never change records. Unattached/replaced photos are not swept on reads.
 * Reset/delete commits text first and journals photo cleanup. If cleanup fails,
 * error.recordsSaved === true: refresh UI, show error; repeat reset/delete to retry.
 * Storage has no cross-device sync. Concurrent writes from separate tabs are not
 * coordinated; use one app context. Actual iPhone/Safari testing is still needed.
 * Verified in Chrome with fictional data: profile reload; photo page close/reopen
 * in the same browser context; unnamed/photo-later cards; immutable createdAt;
 * editable/clearable occurredAt; stable numbering; reset retention/shared photos;
 * full/unavailable storage, failed image saves, and retryable photo cleanup.
 * JPEG output is limited to 1600 px on its longest edge (quality 0.82); smaller
 * supported originals are retained when more efficient. Unsupported image decode
 * fails clearly; UI must offer Add photo later and let users check readability.
 */

const RECORD_KEY = 'caretrail.records.v1';
const PHOTO_DB = 'caretrail.photos';
const PHOTO_STORE = 'photos';
const PROFILE_FIELDS = ['name', 'dateOfBirth', 'sex', 'bloodGroup', 'allergies', 'additionalInfo'];
const EVENT_TYPES = ['symptom', 'injury', 'possible_reaction', 'consultation', 'medication_taken', 'other'];
const REASONS = ['finished_bottle', 'stopped_taking'];
const string = (value) => typeof value === 'string' ? value : '';
const nullable = (value) => string(value) || null;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
let sequence = 0;
let writes = Promise.resolve();

function fail(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function storageError(cause, photo = false) {
  const full = cause?.name === 'QuotaExceededError';
  return fail(photo
    ? `Photo couldn't be saved or accessed; ${full ? 'device storage is full' : 'photo storage is unavailable'}. Try again or add it later.`
    : `Records couldn't be saved or accessed; ${full ? 'device storage is full' : 'browser storage is unavailable'}. Keep your entered details and try again.`,
  full ? 'STORAGE_FULL' : photo ? 'PHOTO_STORAGE_UNAVAILABLE' : 'STORAGE_UNAVAILABLE', cause);
}

function id() {
  return globalThis.crypto?.randomUUID?.() ||
    `ct-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function profile(value = {}) {
  return Object.fromEntries(PROFILE_FIELDS.map((key) => [key, string(value?.[key])]));
}

function event(value, index = 0) {
  return {
    id: string(value.id) || `legacy-event-${index}`,
    // Missing historical timestamps remain unknown; never fabricate history.
    createdAt: string(value.createdAt), occurredAt: nullable(value.occurredAt),
    type: EVENT_TYPES.includes(value.type) ? value.type : 'other',
    description: string(value.description), medicationId: nullable(value.medicationId),
    doseNote: string(value.doseNote),
  };
}

function medication(value, index = 0) {
  const status = value.status === 'completed' ? 'completed' : 'ongoing';
  return {
    id: string(value.id) || `legacy-medication-${index}`,
    displayNumber: value.displayNumber, name: string(value.name), doseText: string(value.doseText),
    startedAt: nullable(value.startedAt), endedAt: status === 'completed' ? nullable(value.endedAt) : null,
    status, completionReason: status === 'completed' && REASONS.includes(value.completionReason) ? value.completionReason : null,
    photoId: nullable(value.photoId),
  };
}

function read() {
  let raw;
  try { raw = globalThis.localStorage.getItem(RECORD_KEY); }
  catch (error) { throw storageError(error); }
  let data;
  try { data = raw === null ? {} : JSON.parse(raw); }
  catch (error) { throw fail('Saved records could not be read. Existing data was left unchanged.', 'INVALID_STORAGE', error); }
  if (!object(data) || (data.version != null && data.version !== 1) ||
      ['events', 'medications', 'pendingPhotoDeletes'].some((key) => data[key] != null && !Array.isArray(data[key])) ||
      ['events', 'medications'].some((key) => data[key]?.some((item) => !object(item)))) {
    throw fail('Saved records use an unreadable or unsupported format. Existing data was left unchanged.', 'INVALID_STORAGE');
  }
  const medications = (data.medications || []).map(medication);
  let next = Math.max(1, Number.isSafeInteger(data.nextDisplayNumber) ? data.nextDisplayNumber : 1,
    ...medications.map((item) => Number.isSafeInteger(item.displayNumber) && item.displayNumber > 0 ? item.displayNumber + 1 : 1));
  const used = new Set();
  for (const item of medications) {
    if (!Number.isSafeInteger(item.displayNumber) || item.displayNumber < 1 || used.has(item.displayNumber)) item.displayNumber = next++;
    used.add(item.displayNumber);
  }
  return { version: 1, profile: profile(data.profile), events: (data.events || []).map(event),
    medications, nextDisplayNumber: next, pendingPhotoDeletes: (data.pendingPhotoDeletes || []).filter((item) => typeof item === 'string') };
}

function write(data) {
  try { globalThis.localStorage.setItem(RECORD_KEY, JSON.stringify(data)); }
  catch (error) { throw storageError(error); }
}

function mutate(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

function validate(input, kind) {
  if (!object(input)) throw fail('Please supply record details as an object.', 'INVALID_INPUT');
  if (kind === 'event') {
    if (input.type != null && !EVENT_TYPES.includes(input.type)) throw fail('Choose a valid event type.', 'INVALID_INPUT');
    if (input.occurredAt && (typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt)))) throw fail('Enter a valid happened time or leave it blank.', 'INVALID_INPUT');
  } else if (kind === 'medication') {
    if (input.status != null && !['ongoing', 'completed'].includes(input.status)) throw fail('Choose ongoing or completed.', 'INVALID_INPUT');
    if (input.completionReason && !REASONS.includes(input.completionReason)) throw fail('Choose a valid completion reason.', 'INVALID_INPUT');
    for (const key of ['startedAt', 'endedAt']) {
      const value = input[key];
      if (value && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
        throw fail('Enter a valid calendar date or leave it blank.', 'INVALID_INPUT');
      }
    }
  }
}

export async function getProfile() { return read().profile; }
export async function saveProfile(patch) {
  validate(patch, 'profile');
  return mutate(() => { const data = read(); data.profile = profile({ ...data.profile, ...patch }); write(data); return data.profile; });
}
export async function listEvents() { return read().events; }
export async function addEvent(input = {}) {
  validate(input, 'event');
  return mutate(() => {
    const data = read();
    const saved = event({ ...input, id: id(), createdAt: new Date().toISOString(),
      occurredAt: input.occurredAt ? new Date(input.occurredAt).toISOString() : null });
    data.events.push(saved); write(data); return saved;
  });
}
export async function updateEvent(eventId, patch = {}) {
  validate(patch, 'event');
  return mutate(() => {
    const data = read(); const index = data.events.findIndex((item) => item.id === eventId);
    if (index < 0) throw fail('This event no longer exists. Refresh the list and try again.', 'NOT_FOUND');
    const old = data.events[index];
    const saved = event({ ...old, ...patch, id: old.id, createdAt: old.createdAt });
    if (saved.occurredAt) saved.occurredAt = new Date(saved.occurredAt).toISOString();
    data.events[index] = saved; write(data); return saved;
  });
}
export async function deleteEvent(eventId) {
  return mutate(() => { const data = read(); const count = data.events.length;
    data.events = data.events.filter((item) => item.id !== eventId); write(data); return count !== data.events.length; });
}
export async function listMedications() { return read().medications; }
export async function addMedication(input = {}) {
  validate(input, 'medication');
  return mutate(() => { const data = read();
    const saved = medication({ ...input, id: id(), displayNumber: data.nextDisplayNumber++ });
    data.medications.push(saved); write(data); return saved; });
}
export async function updateMedication(medicationId, patch = {}) {
  validate(patch, 'medication');
  return mutate(async () => {
    const data = read(); const index = data.medications.findIndex((item) => item.id === medicationId);
    if (index < 0) throw fail('This medication no longer exists. Refresh the list and try again.', 'NOT_FOUND');
    const old = data.medications[index];
    const saved = medication({ ...old, ...patch, id: old.id, displayNumber: old.displayNumber });
    data.medications[index] = saved;
    queuePhotos(data, old.photoId !== saved.photoId ? [old.photoId] : []);
    write(data); await cleanupPhotos(data); return saved;
  });
}

function openPhotos() {
  return new Promise((resolve, reject) => {
    let request; let settled = false;
    const stop = (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(storageError(error, true)); } };
    const timer = setTimeout(() => stop(new Error('Photo storage timed out')), 8000);
    try { request = globalThis.indexedDB.open(PHOTO_DB, 1); }
    catch (error) { stop(error); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(PHOTO_STORE)) request.result.createObjectStore(PHOTO_STORE); };
    request.onblocked = () => stop(new Error('Close other CareTrail tabs and try again'));
    request.onerror = () => stop(request.error);
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function photoTransaction(mode, action) {
  const db = await openPhotos();
  try {
    return await new Promise((resolve, reject) => {
      let transaction; let result;
      try {
        transaction = db.transaction(PHOTO_STORE, mode);
        result = action(transaction.objectStore(PHOTO_STORE));
      } catch (error) { reject(storageError(error, true)); return; }
      transaction.oncomplete = () => resolve(result?.result ?? null);
      transaction.onabort = () => reject(storageError(transaction.error, true));
      transaction.onerror = () => {}; // Abort is the final outcome, not individual request success.
    });
  } finally { db.close(); }
}

async function preparePhoto(file) {
  if (!(file instanceof Blob) || !file.size || !file.type.startsWith('image/')) {
    throw fail('Choose an image file, or add a photo later.', 'INVALID_PHOTO');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Image decoding timed out')), 15000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('Image format not readable')); };
      image.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image resizing unavailable');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Image encoding unavailable');
    return scale === 1 && file.size < blob.size && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.slice(0, file.size, file.type) : blob;
  } catch (error) {
    throw fail("Photo couldn't be prepared. Try a JPEG or PNG image, or add it later.", 'INVALID_PHOTO', error);
  } finally { URL.revokeObjectURL(url); }
}

export async function savePhoto(file) {
  const blob = await preparePhoto(file); const photoId = id();
  await photoTransaction('readwrite', (store) => store.add(blob, photoId));
  return photoId;
}
export async function getPhotoBlob(photoId) {
  if (!photoId) return null;
  const blob = await photoTransaction('readonly', (store) => store.get(photoId));
  return blob instanceof Blob ? blob : null;
}

function queuePhotos(data, candidates) {
  const retained = new Set(data.medications.map((item) => item.photoId).filter(Boolean));
  data.pendingPhotoDeletes = [...new Set([...data.pendingPhotoDeletes, ...candidates])]
    .filter((photoId) => photoId && !retained.has(photoId));
}
async function cleanupPhotos(data) {
  if (!data.pendingPhotoDeletes.length) return;
  try {
    await photoTransaction('readwrite', (store) => { for (const photoId of data.pendingPhotoDeletes) store.delete(photoId); });
    data.pendingPhotoDeletes = []; write(data);
  } catch (cause) {
    const error = fail('Record changes were saved, but removed photos could not be fully cleared. Close other CareTrail tabs and retry the deletion or reset.', 'PHOTO_CLEANUP_FAILED', cause);
    error.recordsSaved = true; throw error;
  }
}
export async function deleteMedication(medicationId) {
  return mutate(async () => {
    const data = read(); const removed = data.medications.find((item) => item.id === medicationId);
    data.medications = data.medications.filter((item) => item.id !== medicationId);
    // Preserve event text, but remove links to a course that no longer exists.
    data.events = data.events.map((item) => item.medicationId === medicationId ? { ...item, medicationId: null } : item);
    queuePhotos(data, [removed?.photoId]); write(data); await cleanupPhotos(data); return Boolean(removed);
  });
}
export async function startNewRecord() {
  return mutate(async () => {
    const data = read();
    const removed = data.medications.filter((item) => item.status === 'completed');
    data.events = []; data.medications = data.medications.filter((item) => item.status === 'ongoing');
    queuePhotos(data, removed.map((item) => item.photoId));
    write(data); await cleanupPhotos(data);
  });
}
