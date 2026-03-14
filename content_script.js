/**
 * Content Script — runs on https://web.whatsapp.com
 *
 * Responsibilities:
 *  1. Observe the WhatsApp Web DOM for conversation changes
 *  2. Extract phone number / contact name from the open chat header
 *  3. Inject the CRM side panel into the page layout
 *  4. Drive panel state by messaging the background service worker
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────────
const PANEL_ID = 'crm-wa-panel';
const PANEL_WRAPPER_ID = 'crm-wa-panel-wrapper';
const DEBOUNCE_MS = 400;

// WhatsApp Web uses dynamic class names; we target stable data-* attributes and
// aria labels. These selectors may need updating if WhatsApp changes structure.
const SELECTORS = {
  // Main chat area – used to detect when a conversation is open
  chatHeader: '[data-testid="conversation-header"]',
  // The contact/group title inside the header
  contactTitle: '[data-testid="conversation-info-header-chat-title"]',
  // Phone info panel (appears when clicking the contact title)
  phoneSpan: 'span[data-testid="phone"]',
  // Alternative: conversation compose box parent that wraps the whole view
  mainContent: '#main',
  // Conversation list item – used to detect conversation switches
  chatListItem: '[data-testid="cell-frame-container"]',
};

// ─── State ─────────────────────────────────────────────────────────────────────
let currentPhone = null;
let currentName = null;
let panelVisible = true;
let debounceTimer = null;

// ─── Utilities ─────────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(fn, ms);
}

function sendToBackground(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response?.error || 'Unknown error from background'));
        return;
      }
      resolve(response.data);
    });
  });
}

// ─── Phone extraction ──────────────────────────────────────────────────────────

/**
 * Try to extract the phone number from the WhatsApp Web DOM.
 * WhatsApp Web encodes the phone as the chat JID: e.g. "5511999990000@c.us"
 * It also appears in the URL hash: #/chat/5511999990000@c.us
 */
function extractPhoneFromUrl() {
  const hash = window.location.href;
  const match = hash.match(/[?&/]([0-9]{7,15})[@-]/);
  return match ? match[1] : null;
}

function extractPhoneFromDOM() {
  // WhatsApp sometimes puts the phone inside a span inside the contact info panel
  const phoneEl = document.querySelector(SELECTORS.phoneSpan);
  if (phoneEl) {
    return phoneEl.textContent.trim().replace(/\D/g, '');
  }

  // Fallback: read from the page title attribute of the chat header
  const titleEl = document.querySelector(SELECTORS.contactTitle);
  if (titleEl) {
    const txt = titleEl.title || titleEl.textContent || '';
    const digits = txt.replace(/\D/g, '');
    if (digits.length >= 8) return digits;
  }

  return null;
}

function extractNameFromDOM() {
  const titleEl = document.querySelector(SELECTORS.contactTitle);
  if (!titleEl) return null;
  return (titleEl.title || titleEl.textContent || '').trim();
}

/**
 * WhatsApp Web stores the active chat JID in a React fiber.
 * This is the most reliable method.
 */
function extractPhoneFromReactFiber() {
  try {
    const headerEl = document.querySelector(SELECTORS.chatHeader);
    if (!headerEl) return null;

    // Walk React fiber to find the jid prop
    let fiber = headerEl._reactFiber || headerEl[Object.keys(headerEl).find(k => k.startsWith('__reactFiber'))];
    let depth = 0;
    while (fiber && depth < 30) {
      const jid = fiber?.memoizedProps?.jid || fiber?.pendingProps?.jid;
      if (jid && typeof jid === 'string') {
        const digits = jid.replace(/\D/g, '');
        if (digits.length >= 8) return digits;
      }
      fiber = fiber.return;
      depth++;
    }
  } catch (_) {
    // React fiber walk failed — fall through to DOM method
  }
  return null;
}

function getCurrentChatInfo() {
  const phone =
    extractPhoneFromReactFiber() ||
    extractPhoneFromDOM() ||
    extractPhoneFromUrl();
  const name = extractNameFromDOM();
  return { phone, name };
}

// ─── Panel injection ───────────────────────────────────────────────────────────

function createPanelSkeleton() {
  const wrapper = document.createElement('div');
  wrapper.id = PANEL_WRAPPER_ID;
  wrapper.innerHTML = `
    <div id="${PANEL_ID}" class="crm-panel">
      <!-- Toggle button -->
      <button class="crm-panel__toggle" id="crmPanelToggle" title="Recolher painel CRM">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      <!-- Header -->
      <div class="crm-panel__header">
        <div class="crm-panel__logo">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
          </svg>
          <span>Painel CRM</span>
        </div>
        <div class="crm-panel__actions-top">
          <button class="crm-btn crm-btn--icon" id="crmRefreshBtn" title="Recarregar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="crm-panel__body" id="crmPanelBody">
        <!-- Filled dynamically -->
        <div class="crm-state crm-state--idle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p>Abra uma conversa para carregar os dados do CRM</p>
        </div>
      </div>
    </div>
  `;
  return wrapper;
}

function injectPanel() {
  if (document.getElementById(PANEL_WRAPPER_ID)) return;

  const mainEl = document.getElementById('main') || document.querySelector('[data-testid="app-wrapper-web"]');
  if (!mainEl) return;

  const wrapper = createPanelSkeleton();
  document.body.appendChild(wrapper);

  // Toggle visibility
  document.getElementById('crmPanelToggle').addEventListener('click', togglePanel);

  // Refresh button
  document.getElementById('crmRefreshBtn').addEventListener('click', () => {
    currentPhone = null; // force re-fetch
    onConversationChange();
  });
}

function togglePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panelVisible = !panelVisible;
  panel.classList.toggle('crm-panel--collapsed', !panelVisible);
  const btn = document.getElementById('crmPanelToggle');
  btn.title = panelVisible ? 'Recolher painel CRM' : 'Expandir painel CRM';
  btn.querySelector('polyline').setAttribute('points', panelVisible ? '9 18 15 12 9 6' : '15 18 9 12 15 6');
}

// ─── Panel rendering ───────────────────────────────────────────────────────────

function setPanelBody(html) {
  const body = document.getElementById('crmPanelBody');
  if (body) body.innerHTML = html;
}

function renderLoading() {
  setPanelBody(`
    <div class="crm-state crm-state--loading">
      <div class="crm-spinner"></div>
      <p>Buscando no CRM…</p>
    </div>
  `);
}

function renderNotFound(phone, name) {
  setPanelBody(`
    <div class="crm-state crm-state--not-found">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        <line x1="8" y1="11" x2="14" y2="11"/>
      </svg>
      <p>Contato não encontrado no CRM</p>
      <small>${phone || ''}</small>
      <button class="crm-btn crm-btn--primary crm-btn--full" id="crmCreateLeadBtn">
        + Criar novo lead
      </button>
    </div>
    <div class="crm-card" id="crmCreateLeadForm" style="display:none">
      <h4>Novo lead</h4>
      <label>Nome
        <input type="text" id="crmLeadName" placeholder="Nome completo" value="${name || ''}" />
      </label>
      <label>Telefone
        <input type="text" id="crmLeadPhone" placeholder="+55 11 9 0000-0000" value="${phone || ''}" />
      </label>
      <label>Empresa
        <input type="text" id="crmLeadCompany" placeholder="Nome da empresa (opcional)" />
      </label>
      <div class="crm-row">
        <button class="crm-btn crm-btn--ghost" id="crmCancelLeadBtn">Cancelar</button>
        <button class="crm-btn crm-btn--primary" id="crmSaveLeadBtn">Salvar lead</button>
      </div>
      <div class="crm-feedback" id="crmLeadFeedback"></div>
    </div>
  `);

  document.getElementById('crmCreateLeadBtn').addEventListener('click', () => {
    document.getElementById('crmCreateLeadForm').style.display = '';
    document.getElementById('crmCreateLeadBtn').style.display = 'none';
  });

  document.getElementById('crmCancelLeadBtn').addEventListener('click', () => {
    document.getElementById('crmCreateLeadForm').style.display = 'none';
    document.getElementById('crmCreateLeadBtn').style.display = '';
  });

  document.getElementById('crmSaveLeadBtn').addEventListener('click', async () => {
    const feedback = document.getElementById('crmLeadFeedback');
    const btn = document.getElementById('crmSaveLeadBtn');
    const leadName = document.getElementById('crmLeadName').value.trim();
    const leadPhone = document.getElementById('crmLeadPhone').value.trim();
    const leadCompany = document.getElementById('crmLeadCompany').value.trim();

    if (!leadName || !leadPhone) {
      feedback.textContent = 'Nome e telefone são obrigatórios.';
      feedback.className = 'crm-feedback crm-feedback--error';
      return;
    }

    btn.disabled = true;
    feedback.textContent = 'Salvando…';
    feedback.className = 'crm-feedback crm-feedback--loading';

    try {
      const result = await sendToBackground('CREATE_LEAD', {
        name: leadName,
        phone: leadPhone,
        companyName: leadCompany,
      });
      feedback.textContent = 'Lead criado com sucesso!';
      feedback.className = 'crm-feedback crm-feedback--success';
      setTimeout(() => {
        currentPhone = null;
        onConversationChange();
      }, 1200);
    } catch (err) {
      feedback.textContent = `Erro: ${err.message}`;
      feedback.className = 'crm-feedback crm-feedback--error';
      btn.disabled = false;
    }
  });
}

function renderMultipleContacts(contacts) {
  const listItems = contacts
    .map(
      (c, i) => `
    <button class="crm-contact-option" data-index="${i}">
      <strong>${escapeHtml(c.name || 'Sem nome')}</strong>
      <span>${escapeHtml(c.company?.name || '')}</span>
      <small>${escapeHtml(c.stage || '')} · ${escapeHtml(c.status || '')}</small>
    </button>
  `
    )
    .join('');

  setPanelBody(`
    <div class="crm-state crm-state--multiple">
      <p>Múltiplos registros encontrados. Escolha o correto:</p>
      <div class="crm-contact-list">${listItems}</div>
    </div>
  `);

  document.querySelectorAll('.crm-contact-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      renderContact(contacts[idx]);
    });
  });
}

function renderError(message) {
  setPanelBody(`
    <div class="crm-state crm-state--error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p>${escapeHtml(message)}</p>
      <button class="crm-btn crm-btn--ghost" id="crmRetryBtn">Tentar novamente</button>
    </div>
  `);
  document.getElementById('crmRetryBtn').addEventListener('click', () => {
    currentPhone = null;
    onConversationChange();
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderContact(contact) {
  const {
    id,
    name,
    phone,
    company,
    stage,
    status,
    responsible,
    lastNote,
    nextAction,
    tasks = [],
    history = [],
    origin,
  } = contact;

  setPanelBody(`
    <!-- Block 1: Header -->
    <div class="crm-card crm-card--header">
      <div class="crm-contact-avatar">${escapeHtml((name || '?')[0].toUpperCase())}</div>
      <div class="crm-contact-info">
        <h3>${escapeHtml(name || 'Sem nome')}</h3>
        ${company ? `<p class="crm-company">${escapeHtml(company.name)}</p>` : ''}
        ${phone ? `<p class="crm-phone">${escapeHtml(phone)}</p>` : ''}
        <div class="crm-badges">
          ${stage ? `<span class="crm-badge crm-badge--stage">${escapeHtml(stage)}</span>` : ''}
          ${status ? `<span class="crm-badge crm-badge--status">${escapeHtml(status)}</span>` : ''}
        </div>
        ${responsible ? `<p class="crm-responsible">Responsável: ${escapeHtml(responsible.name)}</p>` : ''}
        ${origin ? `<p class="crm-origin">Origem: ${escapeHtml(origin)}</p>` : ''}
      </div>
    </div>

    <!-- Block 2: Quick update -->
    <div class="crm-card" id="crmUpdateBlock">
      <h4>Atualização rápida</h4>
      <label>Etapa
        <input type="text" id="crmStageInput" placeholder="Etapa atual" value="${escapeHtml(stage || '')}" />
      </label>
      <label>Status
        <input type="text" id="crmStatusInput" placeholder="Status atual" value="${escapeHtml(status || '')}" />
      </label>
      <label>Observação
        <textarea id="crmObsInput" placeholder="Escreva uma observação…" rows="3"></textarea>
      </label>
      <button class="crm-btn crm-btn--primary crm-btn--full" id="crmSaveUpdateBtn">Salvar</button>
      <div class="crm-feedback" id="crmUpdateFeedback"></div>
    </div>

    <!-- Block 3: Next action -->
    <div class="crm-card" id="crmNextActionBlock">
      <h4>Próxima ação</h4>
      ${nextAction ? `<div class="crm-next-action-current">
        <strong>${escapeHtml(nextAction.description)}</strong>
        <small>${escapeHtml(nextAction.date || '')} ${escapeHtml(nextAction.time || '')}</small>
      </div>` : ''}
      <label>Descrição
        <input type="text" id="crmNextActionDesc" placeholder="O que fazer?" />
      </label>
      <div class="crm-row">
        <label style="flex:1">Data
          <input type="date" id="crmNextActionDate" />
        </label>
        <label style="flex:1">Hora
          <input type="time" id="crmNextActionTime" />
        </label>
      </div>
      <label>Prioridade
        <select id="crmNextActionPriority">
          <option value="normal">Normal</option>
          <option value="high">Alta</option>
          <option value="urgent">Urgente</option>
        </select>
      </label>
      <button class="crm-btn crm-btn--primary crm-btn--full" id="crmSaveNextActionBtn">Salvar próxima ação</button>
      <div class="crm-feedback" id="crmNextActionFeedback"></div>
    </div>

    <!-- Block 4: Tasks -->
    <div class="crm-card" id="crmTasksBlock">
      <h4>Tarefas</h4>
      ${tasks.length
        ? `<ul class="crm-task-list">${tasks
            .map(
              (t) => `<li class="crm-task-item crm-task-item--${escapeHtml(t.priority || 'normal')}">
              <span>${escapeHtml(t.title)}</span>
              <small>${t.dueDate ? escapeHtml(t.dueDate) : ''}</small>
            </li>`
            )
            .join('')}</ul>`
        : '<p class="crm-empty">Nenhuma tarefa pendente</p>'}
      <button class="crm-btn crm-btn--ghost crm-btn--full" id="crmShowCreateTaskBtn">+ Criar tarefa</button>
      <div id="crmCreateTaskForm" style="display:none">
        <label>Título
          <input type="text" id="crmTaskTitle" placeholder="Título da tarefa" />
        </label>
        <div class="crm-row">
          <label style="flex:1">Prazo
            <input type="date" id="crmTaskDueDate" />
          </label>
          <label style="flex:1">Prioridade
            <select id="crmTaskPriority">
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
              <option value="urgent">Urgente</option>
            </select>
          </label>
        </div>
        <label>Responsável (ID)
          <input type="text" id="crmTaskAssignee" placeholder="ID do responsável (opcional)" />
        </label>
        <div class="crm-row">
          <button class="crm-btn crm-btn--ghost" id="crmCancelTaskBtn">Cancelar</button>
          <button class="crm-btn crm-btn--primary" id="crmSaveTaskBtn">Criar tarefa</button>
        </div>
        <div class="crm-feedback" id="crmTaskFeedback"></div>
      </div>
    </div>

    <!-- Block 5: History -->
    <div class="crm-card" id="crmHistoryBlock">
      <h4>Histórico resumido</h4>
      ${history.length
        ? `<ul class="crm-history-list">${history
            .map(
              (h) => `<li class="crm-history-item">
              <span class="crm-history-type crm-history-type--${escapeHtml(h.type || 'note')}">${escapeHtml(h.type || 'nota')}</span>
              <p>${escapeHtml(h.content || h.description || '')}</p>
              <small>${h.timestamp ? new Date(h.timestamp).toLocaleString('pt-BR') : ''}</small>
            </li>`
            )
            .join('')}</ul>`
        : lastNote
          ? `<ul class="crm-history-list">
              <li class="crm-history-item">
                <span class="crm-history-type crm-history-type--note">nota</span>
                <p>${escapeHtml(lastNote)}</p>
              </li>
            </ul>`
          : '<p class="crm-empty">Sem histórico registrado</p>'}
    </div>

    <!-- Block 6: Quick actions -->
    <div class="crm-card crm-card--actions">
      <h4>Ações rápidas</h4>
      <div class="crm-quick-actions">
        <button class="crm-btn crm-btn--outline" id="crmOpenCrmBtn">Abrir no CRM</button>
      </div>
    </div>
  `);

  // ── Event listeners ──────────────────────────────────────────────────────────

  // Save update (stage + status + observation)
  document.getElementById('crmSaveUpdateBtn').addEventListener('click', async () => {
    const stage = document.getElementById('crmStageInput').value.trim();
    const status = document.getElementById('crmStatusInput').value.trim();
    const obs = document.getElementById('crmObsInput').value.trim();
    const feedback = document.getElementById('crmUpdateFeedback');
    const btn = document.getElementById('crmSaveUpdateBtn');

    btn.disabled = true;
    setFeedback(feedback, 'loading', 'Salvando…');

    try {
      if (stage || status) {
        await sendToBackground('UPDATE_STAGE', { contactId: id, stage, status });
      }
      if (obs) {
        await sendToBackground('ADD_OBSERVATION', { contactId: id, text: obs });
      }
      await sendToBackground('RECORD_TIMELINE', {
        contactId: id,
        eventType: 'quick_update',
        data: { stage, status, obs },
      });
      setFeedback(feedback, 'success', 'Salvo com sucesso!');
      document.getElementById('crmObsInput').value = '';
    } catch (err) {
      setFeedback(feedback, 'error', `Erro: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Save next action
  document.getElementById('crmSaveNextActionBtn').addEventListener('click', async () => {
    const description = document.getElementById('crmNextActionDesc').value.trim();
    const date = document.getElementById('crmNextActionDate').value;
    const time = document.getElementById('crmNextActionTime').value;
    const priority = document.getElementById('crmNextActionPriority').value;
    const feedback = document.getElementById('crmNextActionFeedback');
    const btn = document.getElementById('crmSaveNextActionBtn');

    if (!description) {
      setFeedback(feedback, 'error', 'Descrição obrigatória.');
      return;
    }

    btn.disabled = true;
    setFeedback(feedback, 'loading', 'Salvando…');

    try {
      await sendToBackground('SAVE_NEXT_ACTION', { contactId: id, description, date, time, priority });
      await sendToBackground('RECORD_TIMELINE', {
        contactId: id,
        eventType: 'next_action_set',
        data: { description, date, time, priority },
      });
      setFeedback(feedback, 'success', 'Próxima ação salva!');
    } catch (err) {
      setFeedback(feedback, 'error', `Erro: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Show create task form
  document.getElementById('crmShowCreateTaskBtn').addEventListener('click', () => {
    document.getElementById('crmCreateTaskForm').style.display = '';
    document.getElementById('crmShowCreateTaskBtn').style.display = 'none';
  });

  document.getElementById('crmCancelTaskBtn').addEventListener('click', () => {
    document.getElementById('crmCreateTaskForm').style.display = 'none';
    document.getElementById('crmShowCreateTaskBtn').style.display = '';
  });

  // Save task
  document.getElementById('crmSaveTaskBtn').addEventListener('click', async () => {
    const title = document.getElementById('crmTaskTitle').value.trim();
    const dueDate = document.getElementById('crmTaskDueDate').value;
    const priority = document.getElementById('crmTaskPriority').value;
    const assigneeId = document.getElementById('crmTaskAssignee').value.trim() || undefined;
    const feedback = document.getElementById('crmTaskFeedback');
    const btn = document.getElementById('crmSaveTaskBtn');

    if (!title) {
      setFeedback(feedback, 'error', 'Título obrigatório.');
      return;
    }

    btn.disabled = true;
    setFeedback(feedback, 'loading', 'Criando tarefa…');

    try {
      await sendToBackground('CREATE_TASK', { contactId: id, title, dueDate, priority, assigneeId });
      await sendToBackground('RECORD_TIMELINE', {
        contactId: id,
        eventType: 'task_created',
        data: { title, dueDate, priority },
      });
      setFeedback(feedback, 'success', 'Tarefa criada!');
      document.getElementById('crmTaskTitle').value = '';
      document.getElementById('crmTaskDueDate').value = '';
    } catch (err) {
      setFeedback(feedback, 'error', `Erro: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  // Open in CRM
  document.getElementById('crmOpenCrmBtn').addEventListener('click', async () => {
    const { crmBaseUrl } = await sendToBackground('GET_SETTINGS');
    if (crmBaseUrl) {
      window.open(`${crmBaseUrl}/contacts/${id}`, '_blank');
    }
  });
}

function setFeedback(el, type, message) {
  if (!el) return;
  el.textContent = message;
  el.className = `crm-feedback crm-feedback--${type}`;
}

// ─── Conversation change handler ───────────────────────────────────────────────

async function onConversationChange() {
  const { phone, name } = getCurrentChatInfo();

  // No chat open
  if (!phone && !name) {
    setPanelBody(`
      <div class="crm-state crm-state--idle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>Abra uma conversa para carregar os dados do CRM</p>
      </div>
    `);
    return;
  }

  // Same chat — skip
  if (phone && phone === currentPhone) return;

  currentPhone = phone;
  currentName = name;

  renderLoading();

  try {
    if (!phone) {
      renderNotFound(null, name);
      return;
    }

    const result = await sendToBackground('SEARCH_CONTACT', { phone });

    if (!result || (Array.isArray(result) && result.length === 0)) {
      renderNotFound(phone, name);
      return;
    }

    const contacts = Array.isArray(result) ? result : [result];

    if (contacts.length === 1) {
      // Fetch full record
      try {
        const full = await sendToBackground('GET_CONTACT', { contactId: contacts[0].id });
        renderContact(full);
      } catch (_) {
        renderContact(contacts[0]);
      }
    } else {
      renderMultipleContacts(contacts);
    }
  } catch (err) {
    renderError(err.message);
  }
}

// ─── DOM observation ───────────────────────────────────────────────────────────

function startObserver() {
  const observer = new MutationObserver(() => {
    debounce(onConversationChange, DEBOUNCE_MS);
  });

  // Observe the entire app wrapper for subtree changes (chat switches)
  const root = document.getElementById('app') || document.body;
  observer.observe(root, { childList: true, subtree: true, attributes: false });
}

// ─── Init ──────────────────────────────────────────────────────────────────────

function init() {
  injectPanel();
  startObserver();
  // Trigger initial check
  setTimeout(onConversationChange, 800);
}

// WhatsApp Web is a SPA; wait until the main app element is present
function waitForApp() {
  const el = document.getElementById('app') || document.querySelector('[data-testid="app-wrapper-web"]');
  if (el) {
    init();
  } else {
    setTimeout(waitForApp, 500);
  }
}

waitForApp();
