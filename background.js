/**
 * Background Service Worker
 * Handles: authentication, CRM API communication, caching, session control
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_DELAYS = [2000, 4000, 8000, 16000];

// ─── Mock / Demo mode ─────────────────────────────────────────────────────────

const MOCK_CONTACTS = [
  {
    id: 'mock-001',
    name: 'Carlos Eduardo Mendes',
    phone: '',
    email: 'carlos.mendes@empresa.com.br',
    company: 'Mendes Tecnologia Ltda',
    stage: 'Proposta',
    status: 'Em negociação',
    responsible: 'Você',
    origin: 'WhatsApp',
    crmUrl: '#',
    nextAction: { description: 'Enviar proposta revisada', date: '2026-03-20', time: '10:00', priority: 'alta' },
    tasks: [
      { id: 't1', title: 'Ligar para confirmar reunião', dueDate: '2026-03-15', priority: 'alta', done: false },
      { id: 't2', title: 'Enviar catálogo de produtos', dueDate: '2026-03-18', priority: 'media', done: false },
    ],
    timeline: [
      { type: 'note', label: 'Observação', text: 'Cliente demonstrou interesse no plano anual.', date: '2026-03-10 14:32' },
      { type: 'stage', label: 'Etapa', text: 'Movido de Qualificação → Proposta', date: '2026-03-08 09:15' },
      { type: 'task', label: 'Tarefa', text: 'Tarefa criada: Enviar catálogo', date: '2026-03-07 11:00' },
    ],
  },
  {
    id: 'mock-002',
    name: 'Ana Paula Ferreira',
    phone: '',
    email: 'ana.ferreira@startup.io',
    company: 'Startup Inovação S.A.',
    stage: 'Qualificação',
    status: 'Novo contato',
    responsible: 'Você',
    origin: 'Indicação',
    crmUrl: '#',
    nextAction: null,
    tasks: [],
    timeline: [
      { type: 'note', label: 'Observação', text: 'Primeiro contato via WhatsApp.', date: '2026-03-13 16:00' },
    ],
  },
];

// In-memory state for mock operations
const mockState = {
  contacts: JSON.parse(JSON.stringify(MOCK_CONTACTS)),
  nextId: 100,
};

function getMockContact(index = 0) {
  return mockState.contacts[index % mockState.contacts.length];
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mockSearchContact(phone) {
  await delay(400);
  const normalised = normalisePhone(phone);
  // Return different contacts for different phones to simulate variety
  const idx = parseInt(normalised.slice(-1), 10) % 3;
  if (idx === 2) return []; // Simulate "not found" for some numbers
  const contact = JSON.parse(JSON.stringify(getMockContact(idx)));
  contact.phone = normalised;
  return [contact];
}

async function mockGetContact(contactId) {
  await delay(200);
  const found = mockState.contacts.find((c) => c.id === contactId);
  if (found) return JSON.parse(JSON.stringify(found));
  // Fallback: return first mock
  const contact = JSON.parse(JSON.stringify(mockState.contacts[0]));
  contact.id = contactId;
  return contact;
}

async function mockUpdateStage(contactId, stage, status) {
  await delay(300);
  const contact = mockState.contacts.find((c) => c.id === contactId);
  if (contact) {
    contact.timeline.unshift({ type: 'stage', label: 'Etapa', text: `Movido para ${stage} · ${status}`, date: new Date().toLocaleString('pt-BR') });
    contact.stage = stage;
    contact.status = status;
  }
  return { ok: true };
}

async function mockAddObservation(contactId, text) {
  await delay(300);
  const contact = mockState.contacts.find((c) => c.id === contactId);
  if (contact && text) {
    contact.timeline.unshift({ type: 'note', label: 'Observação', text, date: new Date().toLocaleString('pt-BR') });
  }
  return { ok: true };
}

async function mockCreateTask({ contactId, title, dueDate, priority }) {
  await delay(300);
  const contact = mockState.contacts.find((c) => c.id === contactId);
  const task = { id: `t-${mockState.nextId++}`, title, dueDate, priority, done: false };
  if (contact) {
    contact.tasks.unshift(task);
    contact.timeline.unshift({ type: 'task', label: 'Tarefa', text: `Tarefa criada: ${title}`, date: new Date().toLocaleString('pt-BR') });
  }
  return task;
}

async function mockSaveNextAction({ contactId, description, date, time, priority }) {
  await delay(300);
  const contact = mockState.contacts.find((c) => c.id === contactId);
  if (contact) {
    contact.nextAction = { description, date, time, priority };
    contact.timeline.unshift({ type: 'note', label: 'Próxima ação', text: description, date: new Date().toLocaleString('pt-BR') });
  }
  return { ok: true };
}

async function mockCreateLead({ name, phone, companyName }) {
  await delay(400);
  const newContact = {
    id: `mock-${mockState.nextId++}`,
    name,
    phone: normalisePhone(phone),
    email: '',
    company: companyName || '',
    stage: 'Novo Lead',
    status: 'Aguardando contato',
    responsible: 'Você',
    origin: 'WhatsApp',
    crmUrl: '#',
    nextAction: null,
    tasks: [],
    timeline: [{ type: 'note', label: 'Lead criado', text: `Lead criado via extensão WhatsApp.`, date: new Date().toLocaleString('pt-BR') }],
  };
  mockState.contacts.push(newContact);
  return newContact;
}

async function mockRecordTimeline() {
  await delay(100);
  return { ok: true };
}

// ─── In-memory cache ──────────────────────────────────────────────────────────
const contactCache = new Map(); // phone -> { data, timestamp }

function isCacheValid(entry) {
  return entry && Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// ─── Settings helpers ─────────────────────────────────────────────────────────
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { crmBaseUrl: '', apiKey: '', userId: '', userName: '', demoMode: false },
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
  const { demoMode } = await getSettings();
  if (demoMode) return mockSearchContact(phone);

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockGetContact(contactId);

  const { crmBaseUrl, apiKey } = await getSettings();
  const url = `${crmBaseUrl}/api/contacts/${contactId}`;
  return fetchWithRetry(url, { headers: buildHeaders(apiKey) });
}

/**
 * Update the stage / status of a record.
 */
async function updateStage(contactId, stage, status) {
  const { demoMode } = await getSettings();
  if (demoMode) return mockUpdateStage(contactId, stage, status);

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockAddObservation(contactId, text);

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockCreateTask({ contactId, title, dueDate, priority });

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockSaveNextAction({ contactId, description, date, time, priority });

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockCreateLead({ name, phone, companyName });

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
  const { demoMode } = await getSettings();
  if (demoMode) return mockRecordTimeline();

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
