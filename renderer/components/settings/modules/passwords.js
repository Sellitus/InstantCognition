// Saved passwords: each login by site and username with Reveal, Copy and
// Delete, plus the sites the user chose "Never" for. Data comes from the
// passwords:* IPC (PasswordService). Passwords stay in main except for one
// entry on an explicit Reveal. Reveal and Copy go straight to main, which asks
// first itself (Touch ID, or a native dialog the page cannot click through),
// so a stray click or a scripted one never shows or copies a secret.

const { ipcRenderer } = require('electron');
const { el } = require('../controls');
const { errMsg } = require('../../../../shared/errMsg');
const { actionButton, errorRow, setStatus } = require('./kit');

const hostOf = (origin) => {
  try {
    return new URL(origin).host;
  } catch (_) {
    return origin; // Not a URL: show the stored string as-is.
  }
};

const nameOf = (login) => login.username || '(no username)';

function labelled(label, className, iconName, ariaLabel) {
  const btn = actionButton(label, className, iconName);
  btn.setAttribute('aria-label', ariaLabel);
  return btn;
}

async function call(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || !res.ok) throw new Error((res && res.error) || 'no response');
  return res;
}

function savedPasswords({ host }) {
  let disposed = false;

  host.appendChild(el('p', { class: 'sv-section-intro' }, [
    'Logins saved from the save bar, encrypted with your system keychain. ',
    'Fill one by right-clicking a login form in a tab and choosing "Fill saved password".',
  ]));

  const listStatus = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
  const notices = el('div', { 'data-role': 'password-notices' });
  const listEl = el('div', { class: 'sv-spaces-list', 'data-role': 'password-list' });
  host.append(listStatus, notices, listEl);

  host.appendChild(el('h4', { class: 'sv-subhead' }, ['Never saved']));
  const neverEl = el('div', { class: 'sv-spaces-list', 'data-role': 'never-save-list' });
  host.appendChild(neverEl);

  function fail(statusEl, what, err) {
    console.error(`[settings/passwords] ${what} failed:`, errMsg(err));
    setStatus(statusEl, 'error', `Could not ${what}: ${errMsg(err)}`);
  }

  function rowFor(login) {
    const site = hostOf(login.origin);
    const who = `${login.username || '(no username)'} on ${site}`;
    const row = el('div', { class: 'sv-space-row', 'data-login': login.id });
    row.appendChild(el('div', { class: 'sv-persona-row-head' }, [
      el('span', { class: 'sv-persona-title' }, [site]),
      el('span', { class: 'sv-persona-sub' }, [
        nameOf(login), ' · ',
        login.lastUsedAt ? `Last used ${new Date(login.lastUsedAt).toLocaleDateString()}` : 'Never used',
      ]),
    ]));

    const revealed = el('code', { class: 'sv-password-revealed', 'data-role': 'revealed' });
    const status = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
    const actions = el('div', { class: 'sv-actions-row' });
    const revealBtn = labelled('Reveal', 'sv-button', 'eye', `Reveal password for ${who}`);
    const hideBtn = labelled('Hide', 'sv-button', 'eye', `Hide password for ${who}`);
    const copyBtn = labelled('Copy', 'sv-button', 'copy', `Copy password for ${who}`);
    const delBtn = labelled('Delete', 'sv-button sv-button--danger', 'trash', `Delete password for ${who}`);
    let shown = false;

    const showIdle = () => {
      actions.replaceChildren(...(shown ? [revealed, hideBtn] : [revealBtn]), copyBtn, delBtn, status);
    };

    revealBtn.addEventListener('click', async () => {
      setStatus(status, null, '');
      try {
        const res = await call('passwords:reveal', login.id);
        if (disposed) return;
        revealed.textContent = res.password;
        shown = true;
        showIdle();
      } catch (err) {
        fail(status, 'reveal', err);
      }
    });
    hideBtn.addEventListener('click', () => {
      revealed.textContent = '';
      shown = false;
      showIdle();
    });
    copyBtn.addEventListener('click', async () => {
      setStatus(status, null, '');
      try {
        await call('passwords:copy', login.id);
        setStatus(status, 'ok', 'Copied to the clipboard');
      } catch (err) {
        fail(status, 'copy', err);
      }
    });
    delBtn.addEventListener('click', () => {
      const yes = actionButton('Delete saved password', 'sv-button sv-button--danger', 'trash');
      const no = actionButton('Cancel', 'sv-button');
      no.addEventListener('click', showIdle);
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await call('passwords:delete', login.id);
          refresh();
        } catch (err) {
          showIdle();
          fail(status, 'delete', err);
        }
      });
      actions.replaceChildren(el('span', { class: 'sv-field-label' }, [`Delete the saved password for ${who}?`]), yes, no);
      yes.focus();
    });

    showIdle();
    row.appendChild(actions);
    return row;
  }

  function renderNeverSave(origins) {
    if (!origins.length) {
      neverEl.replaceChildren(el('div', { class: 'sv-empty-row' }, ['No sites are excluded. Choose "Never for this site" on the save bar to add one.']));
      return;
    }
    neverEl.replaceChildren(...origins.map((origin) => {
      const site = hostOf(origin);
      const status = el('span', { class: 'sv-validation-status', 'aria-live': 'polite' }, ['']);
      const removeBtn = labelled('Remove', 'sv-button', 'close', `Allow saving on ${site}`);
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        try {
          const res = await call('passwords:never-save-remove', origin);
          if (!disposed) renderNeverSave(Array.isArray(res.neverSave) ? res.neverSave : []);
        } catch (err) {
          removeBtn.disabled = false;
          fail(status, 'remove', err);
        }
      });
      return el('div', { class: 'sv-space-row', 'data-origin': origin }, [
        el('div', { class: 'sv-actions-row' }, [el('span', { class: 'sv-persona-title' }, [site]), removeBtn, status]),
      ]);
    }));
  }

  async function refresh() {
    setStatus(listStatus, 'pending', 'Loading saved passwords…');
    let res;
    try {
      res = await call('passwords:list');
    } catch (err) {
      if (disposed) return;
      console.error('[settings/passwords] list failed:', errMsg(err));
      setStatus(listStatus, null, '');
      listEl.replaceChildren(errorRow(`Couldn't load saved passwords: ${errMsg(err)}`));
      neverEl.replaceChildren();
      return;
    }
    if (disposed) return;
    setStatus(listStatus, null, '');
    const lines = [];
    if (res.status && res.status.available === false) lines.push(errorRow(res.status.reason || 'Passwords cannot be saved on this system.'));
    if (res.quarantined) {
      lines.push(errorRow(`The saved-passwords file could not be read and was set aside as ${res.quarantined}. New passwords start a fresh file.`));
    }
    notices.replaceChildren(...lines);
    const entries = Array.isArray(res.entries) ? res.entries : [];
    listEl.replaceChildren(...(entries.length
      ? entries.map((login) => rowFor(login))
      : [el('div', { class: 'sv-empty-row' }, ['No saved passwords yet. After you sign in to a site, choose Save on the bar that appears.'])]));
    renderNeverSave(Array.isArray(res.neverSave) ? res.neverSave : []);
  }

  refresh();
  return () => {
    disposed = true;
    for (const node of host.querySelectorAll('[data-role="revealed"]')) node.textContent = '';
  };
}

module.exports = { savedPasswords };
