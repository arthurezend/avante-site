/**
 * Background Service Worker
 * Handles: authentication, CRM API communication, caching, session control
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_DELAYS = [2000, 4000, 8000, 16000];

// ─── In-memory cache ──────────────────────────────────────────────────────────
const contactCache = new Map(); // phone -> { data, timestamp }

function isCacheValid(entry) {
  return entry && Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ─── Settings helpers ─────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { crmBaseUrl: '', apiKey: '', userId: '', userName: '' },
      resolve
    );
  });
}

// ─── HTTP helper with retry ───────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return await response.json();
  } catch (err) {
    if (retryCount < RETRY_DELAYS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[retryCount]));
      return fetchWithRetry(url, options, retryCount + 1);
    }
    throw err;
  }
}

// ─── CRM API ──────────────────────────────────────────────────────────────────

/**
 * Normalise a phone number to digits only, removing the leading + or 0.
 */
function normalisePhone(raw) {
  return raw.replace(/\D/g, '');
}

/**
 * Build the standard headers for every CRM request.
 */
function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * Search the CRM for a contact by phone number.
 * Returns an array of matches (may be empty, single or multiple).
 */
async function searchContactByPhone(phone) {
  const cacheKey = normalisePhone(phone);

  if (isCacheValid(contactCache.get(cacheKey))) {
    return contactCache.get(cacheKey).data;
  }

  const { crmBaseUrl, apiKey } = await getSettings();
  if (!crmBaseUrl || !apiKey) {
    throw new Error('CRM não configurado. Acesse as configurações da extensão.');
  }

  const normalised = normalisePhone(phone);
  const url = `${crmBaseUrl}/api/contacts/search?phone=${encodeURIComponent(normalised)}`;
  const data = await fetchWithRetry(url, { headers: buildHeaders(apiKey) });

  contactCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

/**
 * Get the full CRM record for a single contact/lead/deal.
 */
async function getContactRecord(contactId) {
  const { crmBaseUrl, apiKey } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}`;
  return fetchWithRetry(url, { headers: buildHeaders(apiKey) });
}

/**
 * Update the stage / status of a record.
 */
async function updateStage(contactId, stage, status) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}`;
  const body = {
    stage,
    status,
    updatedBy: { id: userId, name: userName },
    source: 'whatsapp-crm-extension',
  };

  const result = await fetchWithRetry(url, {
    method: 'PATCH',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });

  // Invalidate cache
  contactCache.delete(contactId);
  return result;
}

/**
 * Add a quick observation / note.
 */
async function addObservation(contactId, text) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}/notes`;
  const body = {
    content: text,
    author: { id: userId, name: userName },
    source: 'whatsapp-crm-extension',
    timestamp: new Date().toISOString(),
  };

  const result = await fetchWithRetry(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });

  contactCache.delete(contactId);
  return result;
}

/**
 * Create a task linked to a contact/deal.
 */
async function createTask({ contactId, title, dueDate, priority, assigneeId }) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/tasks`;
  const body = {
    title,
    dueDate,
    priority,
    assigneeId: assigneeId || userId,
    linkedTo: { type: 'contact', id: contactId },
    createdBy: { id: userId, name: userName },
    source: 'whatsapp-crm-extension',
  };

  return fetchWithRetry(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });
}

/**
 * Save the next scheduled action for a contact.
 */
async function saveNextAction({ contactId, description, date, time, priority }) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}/next-action`;
  const body = {
    description,
    date,
    time,
    priority,
    assignedTo: { id: userId, name: userName },
    source: 'whatsapp-crm-extension',
  };

  const result = await fetchWithRetry(url, {
    method: 'PUT',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });

  contactCache.delete(contactId);
  return result;
}

/**
 * Create a brand-new lead.
 */
async function createLead({ name, phone, companyName }) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/leads`;
  const body = {
    name,
    phone: normalisePhone(phone),
    companyName,
    origin: 'whatsapp-crm-extension',
    assignedTo: { id: userId, name: userName },
    createdAt: new Date().toISOString(),
  };

  return fetchWithRetry(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });
}

/**
 * Record a timeline event for audit.
 */
async function recordTimeline(contactId, eventType, payload) {
  const { crmBaseUrl, apiKey, userId, userName } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}/timeline`;
  const body = {
    eventType,
    payload,
    actor: { id: userId, name: userName },
    source: 'whatsapp-crm-extension',
    timestamp: new Date().toISOString(),
  };

  return fetchWithRetry(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });
}

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { action, payload } = message;

  const handle = async () => {
    switch (action) {
      case 'SEARCH_CONTACT':
        return searchContactByPhone(payload.phone);

      case 'GET_CONTACT':
        return getContactRecord(payload.contactId);

      case 'UPDATE_STAGE':
        return updateStage(payload.contactId, payload.stage, payload.status);

      case 'ADD_OBSERVATION':
        return addObservation(payload.contactId, payload.text);

      case 'CREATE_TASK':
        return createTask(payload);

      case 'SAVE_NEXT_ACTION':
        return saveNextAction(payload);

      case 'CREATE_LEAD':
        return createLead(payload);

      case 'RECORD_TIMELINE':
        return recordTimeline(payload.contactId, payload.eventType, payload.data);

      case 'GET_SETTINGS':
        return getSettings();

      case 'CLEAR_CACHE':
        contactCache.clear();
        return { ok: true };

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  };

  handle()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep channel open for async response
});
