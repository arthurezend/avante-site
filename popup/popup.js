'use strict';

const $ = (id) => document.getElementById(id);

function setFeedback(el, type, msg) {
  el.textContent = msg;
  el.className = `popup-feedback popup-feedback--${type}`;
}

function sendBg(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, payload }, (res) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res?.ok) { reject(new Error(res?.error || 'Erro desconhecido')); return; }
      resolve(res.data);
    });
  });
}

// Load saved settings on open
chrome.storage.sync.get({ crmBaseUrl: '', apiKey: '', userId: '', userName: '' }, (settings) => {
  $('crmBaseUrl').value = settings.crmBaseUrl;
  $('apiKey').value = settings.apiKey;
  $('userId').value = settings.userId;
  $('userName').value = settings.userName;
});

// Save settings
$('saveBtn').addEventListener('click', () => {
  const settings = {
    crmBaseUrl: $('crmBaseUrl').value.trim().replace(/\/$/, ''),
    apiKey: $('apiKey').value.trim(),
    userId: $('userId').value.trim(),
    userName: $('userName').value.trim(),
  };

  const fb = $('saveFeedback');
  setFeedback(fb, 'loading', 'Salvando…');

  chrome.storage.sync.set(settings, () => {
    if (chrome.runtime.lastError) {
      setFeedback(fb, 'error', 'Erro ao salvar: ' + chrome.runtime.lastError.message);
    } else {
      setFeedback(fb, 'success', 'Configurações salvas com sucesso!');
    }
  });
});

// Test connection
$('testBtn').addEventListener('click', async () => {
  const fb = $('testFeedback');
  const btn = $('testBtn');
  btn.disabled = true;
  setFeedback(fb, 'loading', 'Testando conexão…');

  try {
    const settings = await sendBg('GET_SETTINGS');
    if (!settings.crmBaseUrl || !settings.apiKey) {
      setFeedback(fb, 'error', 'Configure URL e API Key primeiro.');
      return;
    }

    const res = await fetch(`${settings.crmBaseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${settings.apiKey}` },
    });

    if (res.ok) {
      setFeedback(fb, 'success', `Conexão OK (HTTP ${res.status})`);
    } else {
      setFeedback(fb, 'error', `Falha: HTTP ${res.status}`);
    }
  } catch (err) {
    setFeedback(fb, 'error', `Erro: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// Clear cache
$('clearCacheBtn').addEventListener('click', async () => {
  const fb = $('cacheFeedback');
  try {
    await sendBg('CLEAR_CACHE');
    setFeedback(fb, 'success', 'Cache limpo com sucesso!');
  } catch (err) {
    setFeedback(fb, 'error', `Erro: ${err.message}`);
  }
});
