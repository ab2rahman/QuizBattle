/* main.js
 * Quiz Battle – Host & Player logic
 * Depend on:
 *  - window.questions (from questions.js)
 *  - window.fb + window.initFirebase (from inline Firebase script in index.html)
 */

(() => {
  'use strict';

  // ============================================================
  // 1. CONSTANTS & GLOBAL STATE
  // ============================================================

  const questions = window.questions || [];

  const QUESTION_DURATION_MS = 10_000; // 10 detik menjawab
  const MAX_SCORE_PER_QUESTION = 10_000;
  const COUNTDOWN_MS = 10_000; // countdown sebelum soal pertama

  let role = null;                // 'host' | 'player' | null
  let currentGameId = null;
  let currentPlayerId = null;
  let currentQuestionIndex = -1;

  // timers
  let hostTimerInterval = null;
  let playerTimerInterval = null;
  const countdownIntervals = {};

  // audio
  let audioCtx = null;
  let selectedAvatar = null;

  // feedback pools
  const successAudios = [
    'assets/success/success1.mp3',
    'assets/success/success2.mp3',
    'assets/success/success3.mp3',
    'assets/success/success4.mp3',
    'assets/success/success5.mp3',
    'assets/success/success6.mp3'
  ];

  const failAudios = [
    'assets/fail/fail1.mp3',
    'assets/fail/fail2.mp3',
    'assets/fail/fail3.mp3',
    'assets/fail/fail4.mp3',
    'assets/fail/fail5.mp3',
    'assets/fail/fail6.mp3',
    'assets/fail/fail7.mp3',
    'assets/fail/fail8.mp3',
    'assets/fail/fail9.mp3'
  ];

  // ============================================================
  // 2. FIREBASE INIT + LOCAL STATE
  // ============================================================

  // Load firebase-config.json kalau ada, lalu panggil window.initFirebase(cfg)
  async function initFirebaseFromFileOrInline() {
    let cfg = null;

    try {
      const res = await fetch('firebase-config.json', { cache: 'no-store' });
      if (res.ok) {
        cfg = await res.json();
        console.log('Loaded firebase-config.json');
      } else {
        console.log('firebase-config.json not found, using inline config');
      }
    } catch (e) {
      console.log('Could not fetch firebase-config.json, using inline config', e);
    }

    const toUse = cfg;
    if (window.initFirebase) {
      try {
        window.initFirebase(toUse);
      } catch (e) {
        console.warn('initFirebase failed', e);
      }
    }

    // tunggu fb siap dulu baru restore state
    for (let i = 0; i < 20; i++) {
      if (window.fb) break;
      await new Promise(r => setTimeout(r, 50));
    }

    restoreState();
  }

  function saveLocalState(obj) {
    try {
      localStorage.setItem('quizbattle_state', JSON.stringify({ ...obj }));
    } catch (e) {
      console.warn('saveLocalState failed', e);
    }
  }

  function loadLocalState() {
    try {
      const raw = localStorage.getItem('quizbattle_state');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function clearLocalState() {
    try {
      localStorage.removeItem('quizbattle_state');
    } catch {
      /* noop */
    }
  }

  async function restoreState() {
    const st = loadLocalState();
    if (!st) return;

    if (st.role) {
      selectRole(st.role);
    }

    if (st.role === 'host' && st.currentGameId) {
      currentGameId = st.currentGameId;
      listenPlayers(currentGameId);
      listenGameChanges(currentGameId);
      document.getElementById('hostGameInfo').classList.remove('hidden');
      setText('gamePinDisplay', st.pin || '----');
    }

    if (st.role === 'player' && st.currentGameId && st.currentPlayerId) {
      currentGameId = st.currentGameId;
      currentPlayerId = st.currentPlayerId;

      listenGameAsPlayer(currentGameId);

      document.getElementById('playerJoinCard').classList.add('hidden');
      document.getElementById('playerWaitingCard').classList.remove('hidden');

      setText('playerNameLabel', st.playerName || '');
      setText('playerGamePinLabel', st.pin || '');

      if (st.playerAvatar) {
        selectedAvatar = st.playerAvatar;
        const picker = document.getElementById('avatarPicker');
        if (picker) {
          Array.from(picker.children).forEach(b => {
            if (b.dataset && b.dataset.avatar === selectedAvatar) {
              b.classList.add('selected');
            } else {
              b.classList.remove('selected');
            }
          });
        }
      }
    }
  }

  // ============================================================
  // 3. GENERIC HELPERS (DOM, TIMER, AUDIO)
  // ============================================================

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function clearElement(el) {
    while (el && el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function playSound(type) {
    try {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
      }

      const ctx = audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      switch (type) {
        case 'timer':
          osc.frequency.value = 900;
          break;
        case 'reveal':
          osc.frequency.value = 600;
          break;
        case 'end':
          osc.frequency.value = 350;
          break;
        default:
          osc.frequency.value = 500;
      }

      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (e) {
      console.log('Audio error:', e);
    }
  }

  function resetHostTimer() {
    if (hostTimerInterval) {
      clearInterval(hostTimerInterval);
      hostTimerInterval = null;
    }
    setText('hostTimerLabel', '10.0s');
  }

  function resetPlayerTimer() {
    if (playerTimerInterval) {
      clearInterval(playerTimerInterval);
      playerTimerInterval = null;
    }
    setText('playerTimerLabel', '10.0s');
  }

  function startTimer(labelId, startedAtMs, isHost) {
    const label = document.getElementById(labelId);
    const startTime = startedAtMs || Date.now();

    const update = () => {
      const now = Date.now();
      const remaining = QUESTION_DURATION_MS - (now - startTime);

      if (!label) return;

      if (remaining <= 0) {
        label.textContent = '0.0s';
        if (isHost) {
          clearInterval(hostTimerInterval);
          hostTimerInterval = null;
        } else {
          clearInterval(playerTimerInterval);
          playerTimerInterval = null;
        }
        return;
      }

      label.textContent = (remaining / 1000).toFixed(1) + 's';
    };

    update();

    if (isHost) {
      if (hostTimerInterval) clearInterval(hostTimerInterval);
      hostTimerInterval = setInterval(update, 100);
    } else {
      if (playerTimerInterval) clearInterval(playerTimerInterval);
      playerTimerInterval = setInterval(update, 100);
    }
  }

  function startCountdown(labelId, startedAtMs, durationMs, onFinish) {
    const label = document.getElementById(labelId);
    if (!label) return;

    if (countdownIntervals[labelId]) {
      clearInterval(countdownIntervals[labelId]);
      delete countdownIntervals[labelId];
    }

    if (typeof startedAtMs !== 'number' || Number.isNaN(startedAtMs)) {
      console.log('startCountdown: non numeric timestamp, fallback to Date.now()', startedAtMs);
      startedAtMs = Date.now();
    }

    const update = () => {
      const now = Date.now();
      const remaining = durationMs - (now - startedAtMs);

      if (remaining <= 0) {
        label.textContent = '0.0s';
        clearInterval(countdownIntervals[labelId]);
        delete countdownIntervals[labelId];
        if (onFinish) onFinish();
        return;
      }

      label.textContent = (remaining / 1000).toFixed(1) + 's';
    };

    update();
    countdownIntervals[labelId] = setInterval(update, 100);
  }

  function generateGamePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // ============================================================
  // 4. UI HELPERS (AVATAR, COLLAPSIBLE, ROLE)
  // ============================================================

  function renderAvatarHtml(avatar, size = 28) {
    if (!avatar) return '';

    const borderRadius = Math.max(6, Math.round(size * 0.18));
    const baseStyle =
      `width:${size}px;height:${size}px;border-radius:${borderRadius}px;` +
      'object-fit:cover;vertical-align:middle;display:inline-block;overflow:hidden;';

    if (typeof avatar === 'string' && (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
      return `<img src="${avatar}" alt="avatar" style="${baseStyle}margin-right:8px;"/>`;
    }

    const fontSize = Math.max(12, Math.round(size * 0.6));
    return `<span style="${baseStyle}background:#111827;color:#f9fafb;display:flex;align-items:center;justify-content:center;margin-right:8px;font-size:${fontSize}px;">${avatar}</span>`;
  }

  function selectPlayerAvatar(emoji, btn) {
    selectedAvatar = emoji;

    const container = document.getElementById('avatarPicker');
    if (container) {
      Array.from(container.children).forEach(b => {
        if (b === btn) b.classList.add('selected');
        else b.classList.remove('selected');
      });
    }

    const st = loadLocalState() || {};
    const nameInput = document.getElementById('playerNameInput');
    st.playerName = st.playerName || (nameInput ? nameInput.value : '') || '';
    st.playerAvatar = selectedAvatar;
    saveLocalState(st);

    const preview = document.getElementById('avatarPreview');
    if (preview) preview.innerHTML = renderAvatarHtml(selectedAvatar) || '?';
  }

  function useAvatarUrl() {
    const url = (document.getElementById('avatarUrlInput') || {}).value || '';
    if (!url) return;

    selectedAvatar = url;

    const container = document.getElementById('avatarPicker');
    if (container) {
      Array.from(container.children).forEach(b => b.classList.remove('selected'));
    }

    const st = loadLocalState() || {};
    st.playerAvatar = selectedAvatar;
    saveLocalState(st);

    const preview = document.getElementById('avatarPreview');
    if (preview) preview.innerHTML = renderAvatarHtml(selectedAvatar) || '?';
  }

  function toggleHostSection(id) {
    const el = document.getElementById(id);
    if (!el) return;

    const isCollapsed = el.classList.toggle('collapsed');
    const body = el.querySelector('.host-section-body');
    if (body) body.style.display = isCollapsed ? 'none' : '';

    el.style.marginBottom = isCollapsed ? '8px' : '16px';

    const icon = el.querySelector('.toggle-icon');
    if (icon) icon.textContent = isCollapsed ? '▲' : '▼';
  }

  document.addEventListener('DOMContentLoaded', () => {
    ['hostLobbySection', 'hostGameInfo', 'hostQuestionCard'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const icon = el.querySelector('.toggle-icon');
      if (!icon) return;
      const isCollapsed = el.classList.contains('collapsed');
      icon.textContent = isCollapsed ? '▲' : '▼';
    });
  });

  function selectRole(selected) {
    role = selected;
    document.getElementById('roleCard').classList.add('hidden');

    if (role === 'host') {
      const hv = document.getElementById('hostView');
      hv.classList.remove('hidden');
      const card = hv.querySelector('.card');
      if (card) {
        card.classList.remove('card-enter');
        void card.offsetWidth;
        card.classList.add('card-enter');
      }
    } else {
      const pv = document.getElementById('playerView');
      pv.classList.remove('hidden');
      const card = pv.querySelector('.card');
      if (card) {
        card.classList.remove('card-enter');
        void card.offsetWidth;
        card.classList.add('card-enter');
      }
    }
  }

  function goToRoleSelection() {
    const name =
      (document.getElementById('playerNameLabel') || {}).textContent ||
      (document.getElementById('playerNameInput') || {}).value ||
      '';

    const isInGame = !!(currentGameId || currentPlayerId || role === 'host');
    if (isInGame) {
      const ok = confirm('Kembali ke pemilihan peran akan meninggalkan game saat ini. Lanjutkan?');
      if (!ok) return;
    }

    const hv = document.getElementById('hostView');
    const pv = document.getElementById('playerView');
    if (hv) hv.classList.add('hidden');
    if (pv) pv.classList.add('hidden');

    document.getElementById('roleCard').classList.remove('hidden');

    saveLocalState({ role: null, playerName: name });

    role = null;
    currentGameId = null;
    currentPlayerId = null;

    const nameInput = document.getElementById('playerNameInput');
    if (nameInput) nameInput.value = name;
  }

  // ============================================================
  // 5. HOST AUTH MODAL
  // ============================================================

  function selectHostRole() {
    document.getElementById('hostPasswordModal').classList.remove('hidden');

    const input = document.getElementById('hostPasswordInput');
    if (input) {
      input.value = '';
      input.focus();
    }

    const err = document.getElementById('hostPasswordError');
    if (err) err.style.display = 'none';

    setTimeout(() => document.addEventListener('keydown', hostModalKeyHandler), 0);
  }

  function closeHostPasswordModal() {
    document.getElementById('hostPasswordModal').classList.add('hidden');
    document.removeEventListener('keydown', hostModalKeyHandler);
  }

  function hostModalKeyHandler(e) {
    if (e.key === 'Escape') closeHostPasswordModal();
    if (e.key === 'Enter') submitHostPassword();
  }

  function submitHostPassword() {
    const input = document.getElementById('hostPasswordInput');
    const err = document.getElementById('hostPasswordError');
    if (!input) return;

    const v = (input.value || '').trim();
    if (v === 'abduarrahman') {
      closeHostPasswordModal();
      selectRole('host');
    } else {
      if (err) {
        err.textContent = 'Password salah.';
        err.style.display = '';
      }
      input.value = '';
      input.focus();
    }
  }

  // ============================================================
  // 6. HOST LOGIC
  // ============================================================

  async function createGame() {
    const pin = generateGamePin();
    const gamesRef = window.fb.ref('games');
    const newRef = window.fb.push(gamesRef);

    const gameData = {
      pin,
      phase: 'lobby',
      createdAt: Date.now(),
      currentQuestionIndex: -1,
      questionStartAt: null,
      questions
    };

    await window.fb.set(newRef, gameData);
    currentGameId = newRef.key;

    document.getElementById('hostGameInfo').classList.remove('hidden');
    setText('gamePinDisplay', pin);
    setText('hostStatusBadge', 'Lobby');
    setText('hostGamePhaseLabel', 'Lobby');

    listenPlayers(currentGameId);
    listenGameChanges(currentGameId);
    saveLocalState({ role: 'host', currentGameId, pin });

    try {
      const hv = document.getElementById('hostView');
      if (hv && !hv.classList.contains('hidden')) {
        const audio = new Audio('assets/pokemon-battle.mp3');
        audio.volume = 0.9;
        audio.play().catch(err => console.log('Create-game audio blocked:', err));
      }
    } catch (e) {
      console.warn('createGame audio error', e);
    }
  }

  function listenPlayers(gameId) {
    const playersRef = window.fb.ref(`games/${gameId}/players`);

    window.fb.onValue(playersRef, snap => {
      const data = snap.val ? snap.val() : snap || {};
      const container = document.getElementById('playersList');
      clearElement(container);

      const playersArr = Object.values(data || {});

      // shuffle
      for (let i = playersArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [playersArr[i], playersArr[j]] = [playersArr[j], playersArr[i]];
      }

      playersArr.forEach(p => {
        const pill = document.createElement('div');
        pill.className = 'player-pill';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'avatar';
        avatarWrap.innerHTML = renderAvatarHtml(p.avatar, 48);

        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = p.name || 'Player';

        pill.appendChild(avatarWrap);
        pill.appendChild(nameEl);
        container.appendChild(pill);
      });
    });
  }

  function listenGameChanges(gameId) {
    const gameRef = window.fb.ref(`games/${gameId}`);

    window.fb.onValue(gameRef, snap => {
      const data = snap.val ? snap.val() : snap || {};
      if (!data) return;

      window.currentGameState = data;

      setText('hostStatusBadge', data.phase.toUpperCase());
      setText('hostGamePhaseLabel', data.phase);

      const prevIdx = currentQuestionIndex;
      const newIdx = data.currentQuestionIndex ?? -1;
      currentQuestionIndex = newIdx;

      const hq = document.getElementById('hostQuestionCard');
      if (hq) {
        if (data.phase && data.phase !== 'lobby') hq.classList.remove('hidden');
        else hq.classList.add('hidden');
      }

      if (data.phase === 'starting') {
        const hostQText = document.getElementById('hostQuestionText');
        const hostOptions = document.getElementById('hostOptionsContainer');
        const hostImg = document.getElementById('hostQuestionImage');

        if (hostQText) hostQText.textContent = '';
        if (hostOptions) clearElement(hostOptions);
        if (hostImg) {
          hostImg.style.display = 'none';
          hostImg.innerHTML = '';
        }

        const hostLabel = document.getElementById('hostCountdownLabel');
        if (hostLabel && (!data.startingAt || typeof data.startingAt !== 'number')) {
          hostLabel.textContent = (COUNTDOWN_MS / 1000).toFixed(1) + 's';
        }

        const scheduleCountdownWithResolvedTs = async () => {
          try {
            let resolved = false;
            for (let i = 0; i < 20; i++) {
              const snap2 = await window.fb.get(gameRef);
              const val2 = snap2 && snap2.val ? snap2.val() : snap2 || {};
              if (val2 && typeof val2.startingAt === 'number') {
                startCountdown('hostCountdownLabel', val2.startingAt, COUNTDOWN_MS, null);
                startCountdown('playerCountdownLabel', val2.startingAt, COUNTDOWN_MS, null);
                resolved = true;
                break;
              }
              await new Promise(r => setTimeout(r, 250));
            }
            if (!resolved) {
              console.log('startCountdown: startingAt did not resolve, using local time');
              const now = Date.now();
              startCountdown('hostCountdownLabel', now, COUNTDOWN_MS, null);
              startCountdown('playerCountdownLabel', now, COUNTDOWN_MS, null);
            }
          } catch (e) {
            console.warn('startCountdown polling failed', e);
            const now = Date.now();
            startCountdown('hostCountdownLabel', now, COUNTDOWN_MS, null);
            startCountdown('playerCountdownLabel', now, COUNTDOWN_MS, null);
          }
        };

        if (data.startingAt && typeof data.startingAt === 'number') {
          startCountdown('hostCountdownLabel', data.startingAt, COUNTDOWN_MS, null);
          startCountdown('playerCountdownLabel', data.startingAt, COUNTDOWN_MS, null);
        } else {
          scheduleCountdownWithResolvedTs();
        }

        try {
          const waiting = document.getElementById('playerWaitingCard');
          const pq = document.getElementById('playerQuestionCard');
          if (waiting) waiting.classList.remove('hidden');
          if (pq) pq.classList.add('hidden');
        } catch {
          /* noop */
        }
      }

      if (data.phase === 'question' && newIdx >= 0) {
        if (newIdx !== prevIdx) {
          showHostQuestion(data);
          resetHostTimer();
          if (data.questionStartAt) startTimer('hostTimerLabel', data.questionStartAt, true);
          playSound('timer');
        } else if (!hostTimerInterval && data.questionStartAt) {
          startTimer('hostTimerLabel', data.questionStartAt, true);
        }
      } else {
        resetHostTimer();
      }

      if (data.phase !== 'starting') {
        const hc = document.getElementById('hostCountdownLabel');
        const pc = document.getElementById('playerCountdownLabel');
        if (hc) hc.textContent = '';
        if (pc) pc.textContent = '';
      }

      if (data.phase === 'ended') {
        playSound('end');
        alert('Game selesai!');
      }

      updateHostLeaderboard(data.players || {});
    });
  }

  function updateHostLeaderboard(playersObj) {
    const container = document.getElementById('hostLeaderboard');
    clearElement(container);

    const players = Object.values(playersObj || {});
    players.sort((a, b) => (b.score || 0) - (a.score || 0));

    players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-item';

      const left = document.createElement('div');
      left.className = 'left';
      const avatarHtml = renderAvatarHtml(p.avatar, 40);

      const nameEl = document.createElement('div');
      nameEl.className = 'player-name';
      nameEl.textContent = p.name || 'Player';

      left.innerHTML = `<strong>${i + 1}.</strong>&nbsp;` + avatarHtml;
      left.appendChild(nameEl);

      const points = document.createElement('div');
      points.className = 'player-points';
      points.textContent = `${p.score || 0} pts`;

      row.appendChild(left);
      row.appendChild(points);
      container.appendChild(row);
    });
  }

  async function startGame() {
    if (!currentGameId) return;

    const gameRef = window.fb.ref(`games/${currentGameId}`);

    await window.fb.update(gameRef, {
      phase: 'starting',
      startingAt: window.fb.serverTimestamp()
    });

    document.getElementById('hostQuestionCard').classList.remove('hidden');

    try {
      if (
        role === 'host' &&
        document.getElementById('hostView') &&
        !document.getElementById('hostView').classList.contains('hidden')
      ) {
        const audio = new Audio('assets/a-few-moments-later-sponge-bob-sfx-fun.mp3');
        audio.volume = 0.9;
        audio.play().catch(err => console.log('SFX blocked:', err));
      }
    } catch (e) {
      console.warn('startGame audio error', e);
    }

    setTimeout(async () => {
      try {
        await window.fb.update(gameRef, {
          phase: 'question',
          currentQuestionIndex: 0,
          questionStartAt: window.fb.serverTimestamp()
        });
      } catch (e) {
        console.error('Failed to start question after countdown', e);
      }
    }, COUNTDOWN_MS + 200);
  }

  async function tryResumeGame() {
    const pin = document.getElementById('hostResumePinInput').value.trim();
    const err = document.getElementById('hostResumeError');
    err.textContent = '';

    if (!pin) {
      err.textContent = 'Masukkan PIN.';
      return;
    }

    try {
      const ok = await resumeGameByPin(pin);
      if (!ok) err.textContent = 'Game dengan PIN itu tidak ditemukan atau sudah selesai.';
    } catch (e) {
      console.error(e);
      err.textContent = 'Terjadi kesalahan saat mencoba melanjutkan.';
    }
  }

  async function resumeGameByPin(pin) {
    const gamesRef = window.fb.ref('games');
    const gamesSnap = await window.fb.get(gamesRef);
    const gamesVal = gamesSnap.val ? gamesSnap.val() : gamesSnap || {};

    let foundId = null;
    Object.entries(gamesVal).forEach(([k, v]) => {
      if (v && v.pin === pin && v.phase !== 'ended') {
        foundId = k;
      }
    });

    if (!foundId) return false;

    currentGameId = foundId;

    document.getElementById('hostGameInfo').classList.remove('hidden');
    setText('gamePinDisplay', pin);

    listenPlayers(currentGameId);
    listenGameChanges(currentGameId);

    saveLocalState({ role: 'host', currentGameId, pin });

    return true;
  }

  function showHostQuestion(gameData) {
    const idx = gameData.currentQuestionIndex;
    const total = (gameData.questions || []).length;

    setText('questionIndexLabel', idx + 1);
    setText('questionTotalLabel', total);

    const q = gameData.questions[idx];
    if (!q) return;

    setText('hostQuestionText', q.text);

    const hostImgWrap = document.getElementById('hostQuestionImage');
    if (hostImgWrap) {
      if (q.image) {
        hostImgWrap.style.display = '';
        hostImgWrap.innerHTML = `<img src="${q.image}" alt="question image"/>`;
      } else {
        hostImgWrap.style.display = 'none';
        hostImgWrap.innerHTML = '';
      }
    }

    const container = document.getElementById('hostOptionsContainer');
    clearElement(container);

    const counts = Array((q.options || []).length).fill(0);
    const playersObj = gameData.players || {};
    Object.values(playersObj).forEach(p => {
      if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
        counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
      }
    });

    q.options.forEach((opt, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'option-btn';
      wrap.dataset.index = String(i);

      const left = document.createElement('div');
      left.style.flex = '1';
      left.textContent = String.fromCharCode(65 + i) + '. ' + opt;

      const cnt = document.createElement('div');
      cnt.className = 'option-count';
      cnt.textContent = String(counts[i] || 0);

      wrap.appendChild(left);
      wrap.appendChild(cnt);
      container.appendChild(wrap);
    });

    try {
      if (role === 'host') {
        const s = new Audio('assets/pew.mp3');
        s.volume = 0.9;
        s.play().catch(() => {});
      }
    } catch {
      /* noop */
    }
  }

  async function nextQuestion() {
    if (!currentGameId) return;

    const gameRef = window.fb.ref(`games/${currentGameId}`);
    const snap = await window.fb.get(gameRef);
    const data = snap.val ? snap.val() : snap || {};
    if (!data) return;

    let idx = data.currentQuestionIndex ?? -1;
    idx++;

    if (idx >= data.questions.length) {
      await endGame();
      return;
    }

    const playersRef = window.fb.ref(`games/${currentGameId}/players`);
    const playersSnap = await window.fb.get(playersRef);
    const players = playersSnap.val ? playersSnap.val() : playersSnap || {};

    Object.keys(players).forEach(pid => {
      const pRef = window.fb.child(playersRef, pid);
      window.fb.update(pRef, {
        currentAnswer: null,
        answerTime: null,
        lastGain: null
      });
    });

    resetHostTimer();

    await window.fb.update(gameRef, {
      currentQuestionIndex: idx,
      phase: 'question',
      questionStartAt: window.fb.serverTimestamp()
    });
  }

  async function revealAnswer() {
    if (!currentGameId) return;

    const gameRef = window.fb.ref(`games/${currentGameId}`);
    const gameSnap = await window.fb.get(gameRef);
    const data = gameSnap.val ? gameSnap.val() : gameSnap || {};
    if (!data) return;

    const idx = data.currentQuestionIndex;
    const correctIndex = data.questions[idx].correctIndex;
    const questionStartAt = data.questionStartAt || null;

    const playersRef = window.fb.ref(`games/${currentGameId}/players`);
    const playersSnap = await window.fb.get(playersRef);
    const players = playersSnap.val ? playersSnap.val() : playersSnap || {};

    const updates = {};

    Object.entries(players).forEach(([pid, p]) => {
      let score = p.score || 0;
      let gain = 0;

      if (p.currentAnswer === correctIndex && p.answerTime && questionStartAt) {
        const deltaMs = p.answerTime - questionStartAt;
        gain = MAX_SCORE_PER_QUESTION - deltaMs;
        if (gain < 0) gain = 0;
        gain = Math.floor(gain);
        score += gain;
      }

      updates[`${pid}/score`] = score;
      updates[`${pid}/lastGain`] = gain;
    });

    await window.fb.update(playersRef, updates);
    await window.fb.update(gameRef, { phase: 'reveal' });

    playSound('reveal');
    resetHostTimer();

    const counts = Array((data.questions[idx].options || []).length).fill(0);
    Object.values(players || {}).forEach(p => {
      if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
        counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
      }
    });

    const container = document.getElementById('hostOptionsContainer');
    Array.from(container.children).forEach((el, i) => {
      const cnt = el.querySelector ? el.querySelector('.option-count') : null;
      if (cnt) cnt.textContent = String(counts[i] || 0);

      if (i === correctIndex) {
        el.classList.add('correct');
        el.classList.remove('wrong');
        if (cnt) cnt.classList.add('correct');
      } else {
        if (counts[i] > 0) el.classList.add('wrong');
        if (cnt) cnt.classList.remove('correct');
      }
    });
  }

  async function endGame() {
    if (!currentGameId) return;

    const gameRef = window.fb.ref(`games/${currentGameId}`);
    await window.fb.update(gameRef, { phase: 'ended' });

    playSound('end');
    resetHostTimer();
    alert('Game diakhiri. Terima kasih!');
    clearLocalState();
  }

  // ============================================================
  // 7. PLAYER LOGIC
  // ============================================================

  async function joinGame() {
    const name = document.getElementById('playerNameInput').value.trim();
    const pin = document.getElementById('pinInput').value.trim();
    const errorEl = document.getElementById('playerJoinError');

    errorEl.textContent = '';

    if (!name || !pin) {
      errorEl.textContent = 'Nama dan PIN wajib diisi.';
      return;
    }

    const chosenAvatar = selectedAvatar || (loadLocalState() && loadLocalState().playerAvatar) || '';
    if (!chosenAvatar) {
      errorEl.textContent = 'Silakan pilih atau unggah ikon profil sebelum bergabung.';
      return;
    }

    const gamesRef = window.fb.ref('games');
    const gamesSnap = await window.fb.get(gamesRef);
    const gamesVal = gamesSnap.val ? gamesSnap.val() : gamesSnap || {};

    let gameId = null;
    Object.entries(gamesVal).forEach(([k, val]) => {
      if (val && val.pin === pin) gameId = k;
    });

    if (!gameId) {
      errorEl.textContent = 'PIN tidak ditemukan.';
      return;
    }

    currentGameId = gameId;

    const playersRef = window.fb.ref(`games/${gameId}/players`);
    const newPlayerRef = window.fb.push(playersRef);

    const avatarToSave = chosenAvatar;
    await window.fb.set(newPlayerRef, {
      name,
      avatar: avatarToSave || '',
      score: 0,
      currentAnswer: null,
      answerTime: null,
      lastGain: null
    });

    currentPlayerId = newPlayerRef.key;

    saveLocalState({
      role: 'player',
      currentGameId,
      currentPlayerId,
      playerName: name,
      pin,
      playerAvatar: avatarToSave
    });

    document.getElementById('playerJoinCard').classList.add('hidden');
    document.getElementById('playerWaitingCard').classList.remove('hidden');

    setText('playerNameLabel', name);
    setText('playerGamePinLabel', pin);

    listenGameAsPlayer(gameId);
  }

  function listenGameAsPlayer(gameId) {
    const gameRef = window.fb.ref(`games/${gameId}`);

    window.fb.onValue(gameRef, snap => {
      const data = snap.val ? snap.val() : snap || {};
      if (!data) return;

      if (data.phase === 'lobby') {
        // tetap menunggu
      } else if (data.phase === 'starting') {
        document.getElementById('playerJoinCard').classList.add('hidden');
        document.getElementById('playerSummaryCard').classList.add('hidden');
        document.getElementById('playerQuestionCard').classList.add('hidden');
        document.getElementById('playerWaitingCard').classList.remove('hidden');

        if (data.startingAt) {
          startCountdown('playerCountdownLabel', data.startingAt, COUNTDOWN_MS, null);
        }
      } else if (data.phase === 'question') {
        showPlayerQuestion(data);
        resetPlayerTimer();
        if (data.questionStartAt) {
          startTimer('playerTimerLabel', data.questionStartAt, false);
        }
      } else if (data.phase === 'reveal') {
        showPlayerReveal(data);
        resetPlayerTimer();
      } else if (data.phase === 'ended') {
        showPlayerSummary(data);
        resetPlayerTimer();
      }
    });

    const playerRef = window.fb.ref(`games/${gameId}/players/${currentPlayerId}`);
    window.fb.onValue(playerRef, snap => {
      const data = snap.val ? snap.val() : snap || {};
      if (!data) return;

      if (data.lastGain != null) {
        setText('playerGainLabel', `Poin soal ini: +${data.lastGain}`);
      } else {
        setText('playerGainLabel', '');
      }
      setText('playerTotalScoreLabel', `Total skor: ${data.score || 0}`);
    });
  }

  async function showPlayerQuestion(gameData) {
    document.getElementById('playerWaitingCard').classList.add('hidden');
    document.getElementById('playerSummaryCard').classList.add('hidden');
    document.getElementById('playerQuestionCard').classList.remove('hidden');

    const idx = gameData.currentQuestionIndex;
    const q = gameData.questions[idx];

    setText('playerQuestionText', q.text);

    const playerImgWrap = document.getElementById('playerQuestionImage');
    if (playerImgWrap) {
      if (q.image) {
        playerImgWrap.style.display = '';
        playerImgWrap.innerHTML = `<img src="${q.image}" alt="question image"/>`;
      } else {
        playerImgWrap.style.display = 'none';
        playerImgWrap.innerHTML = '';
      }
    }

    setText('playerQuestionIndexLabel', idx + 1);
    setText('playerStatusLabel', 'Pilih jawabanmu secepat mungkin!');
    setText('playerGainLabel', '');

    const container = document.getElementById('playerOptionsContainer');
    clearElement(container);

    try {
      if (window._currentFeedbackAudio && typeof window._currentFeedbackAudio.pause === 'function') {
        window._currentFeedbackAudio.pause();
        try {
          window._currentFeedbackAudio.currentTime = 0;
        } catch {
          /* noop */
        }
        window._currentFeedbackAudio = null;
      }
    } catch {
      /* noop */
    }

    const counts = Array((q.options || []).length).fill(0);
    try {
      const playersObj = gameData.players || {};
      Object.values(playersObj).forEach(p => {
        if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
          counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
        }
      });
    } catch {
      /* noop */
    }

    let existingAnswer = null;
    try {
      if (currentGameId && currentPlayerId && window.fb && window.fb.get) {
        const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
        const snap = await window.fb.get(playerRef);
        const pdata = snap && snap.val ? snap.val() : snap || {};
        existingAnswer = typeof pdata.currentAnswer === 'number' ? pdata.currentAnswer : null;
      }
    } catch {
      /* noop */
    }

    q.options.forEach((opt, i) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.dataset.index = String(i);

      const left = document.createElement('div');
      left.style.flex = '1';
      left.textContent = String.fromCharCode(65 + i) + '. ' + opt;

      const cnt = document.createElement('div');
      cnt.className = 'option-count';
      cnt.textContent = String(counts[i] || 0);

      btn.appendChild(left);
      btn.appendChild(cnt);

      btn.onclick = () => submitAnswer(i, btn, container);

      if (existingAnswer !== null && existingAnswer === i) {
        try {
          btn.classList.add('selected');
          btn.setAttribute('aria-pressed', 'true');
          btn.dataset.selected = '1';
          btn.disabled = true;
          btn.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
          btn.style.borderColor = '#3b82f6';
          btn.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
        } catch {
          /* noop */
        }
      }

      container.appendChild(btn);
    });
  }

  function submitAnswer(choiceIndex, btn, container) {
    if (!currentGameId || !currentPlayerId) return;

    const label = document.getElementById('playerTimerLabel');
    const text = label.textContent.replace('s', '');
    const remaining = parseFloat(text);

    if (!Number.isNaN(remaining) && remaining <= 0) {
      setText('playerStatusLabel', 'Waktu habis, tunggu soal berikutnya.');
      return;
    }

    const containerEl = container || (btn && btn.parentElement) || document.getElementById('playerOptionsContainer');
    const selIndex = String(choiceIndex);

    let matched = false;
    Array.from(containerEl.children).forEach(b => {
      const bi = b.dataset && b.dataset.index ? String(b.dataset.index) : null;

      if (bi === selIndex) {
        matched = true;
        b.classList.add('selected');
        b.setAttribute('aria-pressed', 'true');
        b.dataset.selected = '1';
        try {
          b.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
          b.style.borderColor = '#3b82f6';
          b.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
        } catch {
          /* noop */
        }
      } else {
        b.classList.remove('selected');
        b.removeAttribute('aria-pressed');
        delete b.dataset.selected;
        try {
          b.style.background = '';
          b.style.borderColor = '';
          b.style.boxShadow = '';
        } catch {
          /* noop */
        }
      }
      b.disabled = true;
    });

    if (!matched && btn) {
      try {
        btn.classList.add('selected');
        btn.setAttribute('aria-pressed', 'true');
        btn.dataset.selected = '1';
        btn.disabled = true;
        btn.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
        btn.style.borderColor = '#3b82f6';
        btn.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
      } catch {
        /* noop */
      }
    }

    void btn.offsetWidth;
    setText('playerStatusLabel', 'Jawaban terkirim, tunggu host reveal.');

    const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
    window.fb.update(playerRef, {
      currentAnswer: choiceIndex,
      answerTime: window.fb.serverTimestamp()
    });
  }

  function showPlayerReveal(gameData) {
    if (gameData && gameData.phase && gameData.phase !== 'reveal') return;

    const idx = gameData.currentQuestionIndex;
    const q = gameData.questions[idx];
    const correctIndex = q.correctIndex;

    const counts = Array((q.options || []).length).fill(0);
    const playersObj = gameData.players || {};
    Object.values(playersObj).forEach(p => {
      if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
        counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
      }
    });

    const container = document.getElementById('playerOptionsContainer');
    Array.from(container.children).forEach((btn, i) => {
      btn.disabled = true;

      const badge = btn.querySelector ? btn.querySelector('.option-count') : null;
      if (badge) badge.textContent = String(counts[i] || 0);

      if (i === correctIndex) {
        btn.classList.add('correct');
        if (badge) badge.classList.add('correct');
      } else {
        if (counts[i] > 0) btn.classList.add('wrong');
        if (badge) badge.classList.remove('correct');
      }
    });

    setText(
      'playerStatusLabel',
      'Jawaban benar telah ditampilkan. Lihat poinmu lalu tunggu soal berikutnya.'
    );

    try {
      const me = currentPlayerId && playersObj[currentPlayerId] ? playersObj[currentPlayerId] : null;
      const myAnswer = me && typeof me.currentAnswer === 'number' ? me.currentAnswer : null;
      const isSuccess = myAnswer !== null && myAnswer === correctIndex;

      if (currentPlayerId && gameData.phase === 'reveal') {
        playRandomFeedback(!!isSuccess, gameData.phase);
      }
    } catch (e) {
      console.warn('play feedback determination failed', e);
    }
  }

  function playRandomFeedback(isSuccess, passedPhase) {
    const knownPhase = passedPhase || (window.currentGameState && window.currentGameState.phase) || 'unknown';
    console.debug('playRandomFeedback called', { isSuccess, knownPhase, passedPhase, currentPlayerId });

    try {
      if (knownPhase !== 'reveal') {
        console.debug('playRandomFeedback suppressed because phase is not reveal', { knownPhase });
        return;
      }

      const pool = isSuccess ? successAudios : failAudios;
      const pick = pool[Math.floor(Math.random() * pool.length)];

      try {
        if (window._currentFeedbackAudio && typeof window._currentFeedbackAudio.pause === 'function') {
          window._currentFeedbackAudio.pause();
          try {
            window._currentFeedbackAudio.currentTime = 0;
          } catch {
            /* noop */
          }
        }
      } catch {
        /* noop */
      }

      const audio = new Audio(pick);
      window._currentFeedbackAudio = audio;
      audio.volume = 0.9;
      audio.play().catch(e => console.warn('play feedback failed', e));
    } catch (e) {
      console.warn('playRandomFeedback error', e);
    }
  }

  function showPlayerSummary() {
    document.getElementById('playerQuestionCard').classList.add('hidden');
    document.getElementById('playerWaitingCard').classList.add('hidden');
    document.getElementById('playerSummaryCard').classList.remove('hidden');

    const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
    window.fb.get(playerRef).then(snap => {
      const data = snap.val ? snap.val() : snap || {};
      setText('playerFinalScore', data ? data.score || 0 : 0);
    });
  }

  function joinAnotherGame() {
    const stored = loadLocalState() || {};
    const nameFromLabel = (document.getElementById('playerNameLabel') || {}).textContent || '';
    const name =
      stored.playerName || (document.getElementById('playerNameInput') || {}).value || nameFromLabel || '';

    currentGameId = null;
    currentPlayerId = null;

    saveLocalState({ role: 'player', playerName: name });

    document.getElementById('playerSummaryCard').classList.add('hidden');
    document.getElementById('playerWaitingCard').classList.add('hidden');
    document.getElementById('playerQuestionCard').classList.add('hidden');
    document.getElementById('playerJoinCard').classList.remove('hidden');

    document.getElementById('pinInput').value = '';
    document.getElementById('playerNameInput').value = name;
    setText('playerJoinError', '');
  }

  function confirmAndJoinAnotherGame() {
    const ok = confirm('Are you sure you want to leave this game and join another?');
    if (ok) joinAnotherGame();
  }

  // ============================================================
  // 8. DELEGATED CLICK HANDLER (SAFETY NET)
  // ============================================================

  document.addEventListener('click', ev => {
    try {
      const el = ev.target && ev.target.closest ? ev.target.closest('.option-btn') : null;
      if (!el) return;

      if (el.dataset && el.dataset.selected === '1') return;

      const container = el.parentElement || document.getElementById('playerOptionsContainer');
      if (!container) return;

      Array.from(container.children).forEach(b => {
        if (b === el) {
          b.classList.add('selected');
          b.setAttribute('aria-pressed', 'true');
          b.dataset.selected = '1';
          try {
            b.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
            b.style.borderColor = '#3b82f6';
            b.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
          } catch {
            /* noop */
          }
        } else {
          b.classList.remove('selected');
          b.removeAttribute('aria-pressed');
          delete b.dataset.selected;
          try {
            b.style.background = '';
            b.style.borderColor = '';
            b.style.boxShadow = '';
          } catch {
            /* noop */
          }
        }
        try {
          b.disabled = true;
        } catch {
          /* noop */
        }
      });

      console.log('delegated click: option selected, index=', el.dataset && el.dataset.index);
      setText('playerStatusLabel', 'Jawaban terkirim, tunggu host reveal.');

      try {
        const idx = el.dataset && typeof el.dataset.index !== 'undefined' ? parseInt(el.dataset.index, 10) : null;
        if (idx !== null && currentGameId && currentPlayerId && window.fb && window.fb.update) {
          const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
          window.fb.update(playerRef, { currentAnswer: idx, answerTime: window.fb.serverTimestamp() });
        }
      } catch {
        /* noop */
      }
    } catch (e) {
      console.warn('delegated click handler error', e);
    }
  });

  // ============================================================
  // 9. EXPOSE KE WINDOW (dipakai di index.html)
  // ============================================================

  Object.assign(window, {
    // init
    initFirebaseFromFileOrInline,

    // role / navigation
    selectRole,
    selectHostRole,
    goToRoleSelection,

    // host modal
    closeHostPasswordModal,
    submitHostPassword,

    // host logic
    createGame,
    tryResumeGame,
    startGame,
    nextQuestion,
    revealAnswer,
    endGame,
    toggleHostSection,

    // player avatar & join
    selectPlayerAvatar,
    useAvatarUrl,
    joinGame,
    joinAnotherGame,
    confirmAndJoinAnotherGame
  });

  // kick off
  initFirebaseFromFileOrInline();
})();
