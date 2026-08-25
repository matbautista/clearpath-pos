async function renderLoginView() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  let staff = [];
  try {
    staff = await api.get('/api/auth/staff-list');
  } catch (e) {
    toast('Could not reach server', 'error');
  }

  let selectedUser = null;
  let pin = '';

  const errorEl = el('div', { class: 'login-error' }, '');
  const dotsEl = el('div', { class: 'pin-dots' });
  const staffListEl = el('div', { class: 'staff-list' });

  function renderDots() {
    dotsEl.innerHTML = '';
    for (let i = 0; i < 6; i++) {
      dotsEl.appendChild(el('div', { class: `pin-dot ${i < pin.length ? 'filled' : ''}` }));
    }
  }

  function renderStaffList() {
    staffListEl.innerHTML = '';
    staff.forEach((s) => {
      staffListEl.appendChild(
        el('button', {
          class: `staff-btn ${selectedUser && selectedUser.id === s.id ? 'selected' : ''}`,
          onclick: () => { selectedUser = s; pin = ''; errorEl.textContent = ''; renderDots(); renderStaffList(); },
        }, [s.name, el('span', { class: 'staff-role' }, s.role)])
      );
    });
  }

  async function submitPin() {
    if (!selectedUser) { errorEl.textContent = 'Select your name first'; return; }
    try {
      const user = await api.post('/api/auth/login', { userId: selectedUser.id, pin });
      window.APP_STATE.user = user;
      await loadSettings();
      renderShell();
    } catch (e) {
      errorEl.textContent = e.message;
      pin = '';
      renderDots();
    }
  }

  const pinPad = el('div', { class: 'pin-pad' });
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'ok'];
  keys.forEach((k) => {
    pinPad.appendChild(el('button', {
      onclick: () => {
        if (k === 'clear') { pin = ''; }
        else if (k === 'ok') { submitPin(); return; }
        else if (pin.length < 8) { pin += k; }
        renderDots();
      },
    }, k === 'clear' ? 'C' : k === 'ok' ? '✓' : k));
  });

  renderStaffList();
  renderDots();

  const card = el('div', { class: 'login-card' }, [
    el('img', { class: 'login-logo', src: '/assets/logo.png', alt: '' }),
    el('h1', {}, 'Sugbahan'),
    el('p', { class: 'sub' }, 'Select your name and enter your PIN'),
    staffListEl,
    dotsEl,
    errorEl,
    pinPad,
  ]);

  app.appendChild(el('div', { class: 'login-screen' }, [card]));
}
