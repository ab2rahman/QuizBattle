
const questions = window.questions || [];

// =============== CONFIG FIREBASE ===============

// Try to load firebase config from external file `firebase-config.json` (convenient for local dev)
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

    // prefer external config when present
    const toUse = cfg;
    if (window.initFirebase) {
        try { window.initFirebase(toUse); } catch (e) { console.warn('initFirebase failed', e); }
    }

    // helper reference to modular DB helpers (window.fb). Will be set after init.
    var db = window.fb ? window.fb.db : null;

    // wait a short moment for fb to be ready then restore local state
    for (let i = 0; i < 20; i++) {
        if (window.fb) break;
        await new Promise(r => setTimeout(r, 50));
    }
    db = window.fb ? window.fb.db : null;
    restoreState();
}

initFirebaseFromFileOrInline();

// ===== Persistence helpers =====
function saveLocalState(obj) {
    try {
        const s = Object.assign({}, obj);
        localStorage.setItem('quizbattle_state', JSON.stringify(s));
    } catch (e) { console.warn('saveLocalState failed', e); }
}

function loadLocalState() {
    try {
        const raw = localStorage.getItem('quizbattle_state');
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) { return null; }
}

function clearLocalState() {
    try { localStorage.removeItem('quizbattle_state'); } catch (e) { }
}

// restore state after firebase init and reattach listeners
async function restoreState() {
    const st = loadLocalState();
    if (!st) return;
    // reinitialize role UI
    if (st.role) {
        selectRole(st.role);
    }
    if (st.role === 'host' && st.currentGameId) {
        currentGameId = st.currentGameId;
        // reattach host listeners
        listenPlayers(currentGameId);
        listenGameChanges(currentGameId);
        document.getElementById('hostGameInfo').classList.remove('hidden');
        setText('gamePinDisplay', st.pin || '----');
    }
    if (st.role === 'player' && st.currentGameId && st.currentPlayerId) {
        currentGameId = st.currentGameId;
        currentPlayerId = st.currentPlayerId;
        // reattach player listeners
        listenGameAsPlayer(currentGameId);
        document.getElementById('playerJoinCard').classList.add('hidden');
        document.getElementById('playerWaitingCard').classList.remove('hidden');
        setText('playerNameLabel', st.playerName || '');
        setText('playerGamePinLabel', st.pin || '');
        // restore avatar pick UI if present
        if (st.playerAvatar) {
            selectedAvatar = st.playerAvatar;
            const picker = document.getElementById('avatarPicker');
            if (picker) {
                Array.from(picker.children).forEach((b) => {
                    if (b.dataset && b.dataset.avatar === selectedAvatar) b.classList.add('selected'); else b.classList.remove('selected');
                });
            }
        }
    }
}

// =============== STATE & PERTANYAAN ===============

var role = null;
var currentGameId = null;
var currentPlayerId = null;
var currentQuestionIndex = -1;

const QUESTION_DURATION_MS = 10000; // 10 detik
const MAX_SCORE_PER_QUESTION = 10000; // skor awal
const COUNTDOWN_MS = 10000; // countdown sebelum soal pertama

// Timer handler
let hostTimerInterval = null;
let playerTimerInterval = null;
// map of countdown intervals per label id so multiple countdowns can run independently
let countdownIntervals = {};
let countdownTriggeredForGame = {};

// Audio context untuk sound effect
let audioCtx = null;

function playSound(type) {
    try {
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
        }
        const ctx = audioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        if (type === "timer") {
            osc.frequency.value = 900;
        } else if (type === "reveal") {
            osc.frequency.value = 600;
        } else if (type === "end") {
            osc.frequency.value = 350;
        } else {
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
        console.log("Audio error:", e);
    }
}

// avatar state for player
var selectedAvatar = null;

function selectPlayerAvatar(emoji, btn) {
    selectedAvatar = emoji;
    // clear other buttons
    const container = document.getElementById('avatarPicker');
    if (container) {
        Array.from(container.children).forEach((b) => {
            if (b === btn) b.classList.add('selected'); else b.classList.remove('selected');
        });
    }
    // persist selection for convenience
    const st = loadLocalState() || {};
    st.playerName = st.playerName || (document.getElementById('playerNameInput') ? document.getElementById('playerNameInput').value : '') || '';
    st.playerAvatar = selectedAvatar;
    saveLocalState(st);
    // update preview
    const preview = document.getElementById('avatarPreview');
    if (preview) preview.innerHTML = renderAvatarHtml(selectedAvatar) || '?';
}

function useAvatarUrl() {
    const url = (document.getElementById('avatarUrlInput') || {}).value || '';
    if (!url) return;
    selectedAvatar = url;
    // clear avatar buttons selection
    const container = document.getElementById('avatarPicker');
    if (container) Array.from(container.children).forEach(b => b.classList.remove('selected'));
    // persist
    const st = loadLocalState() || {};
    st.playerAvatar = selectedAvatar;
    saveLocalState(st);
    // update preview to show image
    const preview = document.getElementById('avatarPreview');
    if (preview) preview.innerHTML = renderAvatarHtml(selectedAvatar) || '?';
}

function renderAvatarHtml(avatar, size = 28) {
    if (!avatar) return '';
    const borderRadius = Math.max(6, Math.round(size * 0.18));
    const styleBase = `width:${size}px;height:${size}px;border-radius:${borderRadius}px;object-fit:cover;vertical-align:middle;display:inline-block;overflow:hidden;`;
    if (typeof avatar === 'string' && (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
        return `<img src="${avatar}" alt="avatar" style="${styleBase}margin-right:8px;"/>`;
    }
    // emoji or short text
    const fontSize = Math.max(12, Math.round(size * 0.6));
    return `<span style="${styleBase}background:#111827;color:#f9fafb;display:flex;align-items:center;justify-content:center;margin-right:8px;font-size:${fontSize}px;">${avatar}</span>`;
}

// =============== HELPER ===============

function toggleHostSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const isCollapsed = el.classList.toggle('collapsed');
    const body = el.querySelector('.host-section-body');
    if (body) body.style.display = isCollapsed ? 'none' : '';
    // add spacing when expanded
    if (!isCollapsed) el.style.marginBottom = '16px'; else el.style.marginBottom = '8px';
    // update icon
    const icon = el.querySelector('.toggle-icon');
    if (icon) icon.textContent = isCollapsed ? '▲' : '▼';
}

// initialize toggle icons for host sections
document.addEventListener('DOMContentLoaded', () => {
    ['hostLobbySection', 'hostGameInfo', 'hostQuestionCard'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const icon = el.querySelector('.toggle-icon');
        if (icon) {
            const isCollapsed = el.classList.contains('collapsed');
            icon.textContent = isCollapsed ? '▲' : '▼';
        }
    });
});

function selectRole(selected) {
    role = selected;
    document.getElementById("roleCard").classList.add("hidden");
    if (role === "host") {
        const hv = document.getElementById("hostView");
        hv.classList.remove("hidden");
        const card = hv.querySelector('.card'); if (card) { card.classList.remove('card-enter'); void card.offsetWidth; card.classList.add('card-enter'); }
    } else {
        const pv = document.getElementById("playerView");
        pv.classList.remove("hidden");
        const card = pv.querySelector('.card'); if (card) { card.classList.remove('card-enter'); void card.offsetWidth; card.classList.add('card-enter'); }
    }
}

function goToRoleSelection() {
    // preserve player name if available
    const name = (document.getElementById('playerNameLabel') ? document.getElementById('playerNameLabel').textContent : '') || (document.getElementById('playerNameInput') ? document.getElementById('playerNameInput').value : '') || '';

    // If user is currently in a game (host or player), confirm before navigating back
    const isInGame = !!(currentGameId || currentPlayerId || role === 'host');
    if (isInGame) {
        const ok = confirm('Kembali ke pemilihan peran akan meninggalkan game saat ini. Lanjutkan?');
        if (!ok) return; // abort navigation
    }

    // clear role/UI
    const hv = document.getElementById('hostView'); if (hv) hv.classList.add('hidden');
    const pv = document.getElementById('playerView'); if (pv) pv.classList.add('hidden');
    document.getElementById('roleCard').classList.remove('hidden');
    // clear persisted role but keep name
    saveLocalState({ role: null, playerName: name });
    role = null;
    currentGameId = null;
    currentPlayerId = null;
    // prefill name input
    const nameInput = document.getElementById('playerNameInput'); if (nameInput) nameInput.value = name;
}

function selectHostRole() {
    // open styled modal
    document.getElementById('hostPasswordModal').classList.remove('hidden');
    const input = document.getElementById('hostPasswordInput');
    if (input) { input.value = ''; input.focus(); }
    const err = document.getElementById('hostPasswordError'); if (err) err.style.display = 'none';
    // attach escape handler
    setTimeout(() => { document.addEventListener('keydown', hostModalKeyHandler); }, 0);
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
        if (err) { err.textContent = 'Password salah.'; err.style.display = ''; }
        // clear input to avoid visible typing
        input.value = '';
        input.focus();
    }
}

function generateGamePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

function resetHostTimer() {
    if (hostTimerInterval) {
        clearInterval(hostTimerInterval);
        hostTimerInterval = null;
    }
    setText("hostTimerLabel", "10.0s");
}

function resetPlayerTimer() {
    if (playerTimerInterval) {
        clearInterval(playerTimerInterval);
        playerTimerInterval = null;
    }
    setText("playerTimerLabel", "10.0s");
}

function startTimer(labelId, startedAtMs, isHost) {
    const label = document.getElementById(labelId);
    const startTime = startedAtMs || Date.now();

    const update = () => {
        const now = Date.now();
        const remaining = QUESTION_DURATION_MS - (now - startTime);
        if (remaining <= 0) {
            label.textContent = "0.0s";
            if (isHost) {
                clearInterval(hostTimerInterval);
                hostTimerInterval = null;
            } else {
                clearInterval(playerTimerInterval);
                playerTimerInterval = null;
            }
            return;
        }
        label.textContent = (remaining / 1000).toFixed(1) + "s";
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

// Generic countdown that counts down to (startAt + durationMs)
function startCountdown(labelId, startedAtMs, durationMs, onFinish) {
    const label = document.getElementById(labelId);
    if (!label) return;
    // clear any existing interval for this label
    if (countdownIntervals[labelId]) { clearInterval(countdownIntervals[labelId]); delete countdownIntervals[labelId]; }

    // normalize startedAtMs: if firebase returned a placeholder (object), try to extract timestamp or fallback to now
    if (typeof startedAtMs !== 'number' || isNaN(startedAtMs)) {
        // If it's an object with a .toMillis or similar, attempt best-effort
        try {
            if (startedAtMs && typeof startedAtMs === 'object') {
                // firebase sometimes returns {'.sv': 'timestamp'} when reading before server resolution; fallback to Date.now()
                console.log('startCountdown: startedAtMs is object, falling back to Date.now()', startedAtMs);
            }
        } catch (e) { }
        startedAtMs = Date.now();
    }

    const update = () => {
        const now = Date.now();
        const remaining = durationMs - (now - startedAtMs);
        if (remaining <= 0) {
            label.textContent = "0.0s";
            if (countdownIntervals[labelId]) { clearInterval(countdownIntervals[labelId]); delete countdownIntervals[labelId]; }
            if (onFinish) onFinish();
            return;
        }
        label.textContent = (remaining / 1000).toFixed(1) + "s";
    };

    update();
    countdownIntervals[labelId] = setInterval(update, 100);
}

// =============== HOST LOGIC ===============

async function createGame() {
    const pin = generateGamePin();
    const gamesRef = window.fb.ref("games");
    const newRef = window.fb.push(gamesRef);

    const gameData = {
        pin,
        phase: "lobby",
        createdAt: Date.now(),
        currentQuestionIndex: -1,
        questionStartAt: null,
        questions,
    };

    await window.fb.set(newRef, gameData);
    currentGameId = newRef.key;

    document.getElementById("hostGameInfo").classList.remove("hidden");
    setText("gamePinDisplay", pin);
    setText("hostStatusBadge", "Lobby");
    setText("hostGamePhaseLabel", "Lobby");

    listenPlayers(currentGameId);
    listenGameChanges(currentGameId);
    // persist host state
    saveLocalState({ role: 'host', currentGameId, pin });
    // Play battle audio for host when creating a game
    try {
        if (role === 'host' || true) { // role may not be set yet; check hostView visibility instead
            const hv = document.getElementById('hostView');
            if (hv && !hv.classList.contains('hidden')) {
                const audio = new Audio('assets/pokemon-battle.mp3');
                audio.volume = 0.9;
                audio.play().catch((err) => { console.log('Create-game audio blocked:', err); });
            }
        }
    } catch (e) { console.warn('createGame audio error', e); }
}

function listenPlayers(gameId) {
    const playersRef = window.fb.ref(`games/${gameId}/players`);
    window.fb.onValue(playersRef, (snap) => {
        const data = snap.val ? snap.val() : snap || {};
        const container = document.getElementById("playersList");
        clearElement(container);
        // render as centered pills (no points) and randomize order
        const playersArr = Object.values(data || {});
        // shuffle
        for (let i = playersArr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [playersArr[i], playersArr[j]] = [playersArr[j], playersArr[i]];
        }
        playersArr.forEach((p) => {
            const pill = document.createElement('div');
            pill.className = 'player-pill';
            const avatarWrap = document.createElement('div'); avatarWrap.className = 'avatar';
            avatarWrap.innerHTML = renderAvatarHtml(p.avatar, 48);
            const nameEl = document.createElement('div'); nameEl.className = 'name'; nameEl.textContent = p.name || 'Player';
            pill.appendChild(avatarWrap);
            pill.appendChild(nameEl);
            container.appendChild(pill);
        });
    });
}

function listenGameChanges(gameId) {
    const gameRef = window.fb.ref(`games/${gameId}`);
    window.fb.onValue(gameRef, (snap) => {
        const data = snap.val ? snap.val() : snap || {};
        if (!data) return;
        // expose latest game data for debug/logging
        window.currentGameState = data;

        setText("hostStatusBadge", data.phase.toUpperCase());
        setText("hostGamePhaseLabel", data.phase);

        const prevIdx = currentQuestionIndex;
        const newIdx = data.currentQuestionIndex ?? -1;
        currentQuestionIndex = newIdx;

        // Show Questions & Controls only when game is not in lobby
        const hq = document.getElementById('hostQuestionCard');
        if (hq) {
            if (data.phase && data.phase !== 'lobby') {
                hq.classList.remove('hidden');
            } else {
                hq.classList.add('hidden');
            }
        }

        // Starting phase: show countdown to players and host
        if (data.phase === "starting") {
            // Ensure Questions & Controls card is visible for host but hide actual question content until countdown finishes
            const hostQText = document.getElementById('hostQuestionText');
            const hostOptions = document.getElementById('hostOptionsContainer');
            const hostImg = document.getElementById('hostQuestionImage');
            if (hostQText) hostQText.textContent = '';
            if (hostOptions) clearElement(hostOptions);
            if (hostImg) { hostImg.style.display = 'none'; hostImg.innerHTML = ''; }

            // start synchronized countdown for host and players
            // If startingAt is not yet a numeric server timestamp (firebase may return a placeholder),
            // poll briefly until it resolves, otherwise fallback to Date.now(). This avoids the host
            // seeing no countdown when the server timestamp hasn't propagated yet.
            const hostLabel = document.getElementById('hostCountdownLabel');
            if (hostLabel && (!data.startingAt || typeof data.startingAt !== 'number')) {
                // show an initial value so host sees something immediately
                hostLabel.textContent = (COUNTDOWN_MS / 1000).toFixed(1) + 's';
            }

            const scheduleCountdownWithResolvedTs = async () => {
                try {
                    // try to read the resolved startingAt for a short window
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
                        console.log('startCountdown: startingAt did not resolve, falling back to local Date.now()');
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
                // kick off polling/resolution without blocking
                scheduleCountdownWithResolvedTs();
            }

            // Ensure players see the waiting card (not the question card) while countdown runs
            try {
                const pv = document.getElementById('playerView');
                const waiting = document.getElementById('playerWaitingCard');
                const pq = document.getElementById('playerQuestionCard');
                if (waiting) waiting.classList.remove('hidden');
                if (pq) pq.classList.add('hidden');
            } catch (e) { }
        }

        if (data.phase === "question" && newIdx >= 0) {
            if (newIdx !== prevIdx) {
                showHostQuestion(data);
                resetHostTimer();
                if (data.questionStartAt) {
                    startTimer("hostTimerLabel", data.questionStartAt, true);
                }
                playSound("timer");
            } else if (!hostTimerInterval && data.questionStartAt) {
                startTimer("hostTimerLabel", data.questionStartAt, true);
            }
        } else {
            resetHostTimer();
        }

        // hide countdown labels when not in starting phase
        if (data.phase !== 'starting') {
            const hc = document.getElementById('hostCountdownLabel'); if (hc) hc.textContent = '';
            const pc = document.getElementById('playerCountdownLabel'); if (pc) pc.textContent = '';
        }

        if (data.phase === "ended") {
            playSound("end");
            alert("Game selesai!");
        }

        updateHostLeaderboard(data.players || {});
    });
}

function updateHostLeaderboard(playersObj) {
    const container = document.getElementById("hostLeaderboard");
    clearElement(container);
    const players = Object.values(playersObj || {});
    players.sort((a, b) => (b.score || 0) - (a.score || 0));
    players.forEach((p, i) => {
        const row = document.createElement('div');
        row.className = 'leaderboard-item';
        const left = document.createElement('div'); left.className = 'left';
        const avatarHtml = renderAvatarHtml(p.avatar, 40);
        const nameEl = document.createElement('div'); nameEl.className = 'player-name'; nameEl.textContent = p.name || 'Player';
        left.innerHTML = `<strong>${i + 1}.</strong>&nbsp;` + avatarHtml;
        left.appendChild(nameEl);

        const points = document.createElement('div'); points.className = 'player-points'; points.textContent = `${p.score || 0} pts`;
        row.appendChild(left);
        row.appendChild(points);
        container.appendChild(row);
    });
}

async function startGame() {
    if (!currentGameId) return;
    const gameRef = window.fb.ref(`games/${currentGameId}`);
    // Set a 'starting' phase so clients can show countdown
    await window.fb.update(gameRef, {
        phase: "starting",
        startingAt: window.fb.serverTimestamp()
    });
    document.getElementById("hostQuestionCard").classList.remove("hidden");
    // Play battle music for host only
    try {
        // Play SFX for host when starting countdown begins
        if (role === 'host' && document.getElementById('hostView') && !document.getElementById('hostView').classList.contains('hidden')) {
            const audio = new Audio('assets/a-few-moments-later-sponge-bob-sfx-fun.mp3');
            audio.volume = 0.9;
            audio.play().catch((err) => { console.log('SFX blocked:', err); });
        }
    } catch (e) { console.warn('startGame audio error', e); }

    // Host schedules server update to move into first question after countdown
    setTimeout(async () => {
        try {
            await window.fb.update(gameRef, {
                phase: "question",
                currentQuestionIndex: 0,
                questionStartAt: window.fb.serverTimestamp()
            });
        } catch (e) { console.error('Failed to start question after countdown', e); }
    }, COUNTDOWN_MS + 200); // small buffer
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
    // search for a game with this PIN
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
    // attach host views
    document.getElementById('hostGameInfo').classList.remove('hidden');
    setText('gamePinDisplay', pin);
    // reattach listeners
    listenPlayers(currentGameId);
    listenGameChanges(currentGameId);

    // persist host state
    saveLocalState({ role: 'host', currentGameId, pin });

    return true;
}

function showHostQuestion(gameData) {
    const idx = gameData.currentQuestionIndex;
    const total = (gameData.questions || []).length;
    setText("questionIndexLabel", idx + 1);
    setText("questionTotalLabel", total);

    const q = gameData.questions[idx];
    if (!q) return;

    setText("hostQuestionText", q.text);
    // render optional image
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

    const container = document.getElementById("hostOptionsContainer");
    clearElement(container);

    // compute counts from gameData.players
    const counts = Array((q.options || []).length).fill(0);
    const playersObj = gameData.players || {};
    Object.values(playersObj).forEach((p) => {
        if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
            counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
        }
    });

    q.options.forEach((opt, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'option-btn';
        wrap.dataset.index = String(i);
        // left label
        const left = document.createElement('div'); left.style.flex = '1';
        left.textContent = String.fromCharCode(65 + i) + '. ' + opt;
        // right count badge
        const cnt = document.createElement('div');
        cnt.className = 'option-count';
        cnt.textContent = String(counts[i] || 0);

        wrap.appendChild(left);
        wrap.appendChild(cnt);
        container.appendChild(wrap);
    });

    // Play short 'pew' SFX when host view shows a question
    try {
        if (role === 'host') {
            const s = new Audio('assets/pew.mp3');
            s.volume = 0.9;
            s.play().catch((e) => { /* ignore autoplay blocks */ });
        }
    } catch (e) { }
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
    Object.keys(players).forEach((pid) => {
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
        phase: "question",
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

        updates[pid + "/score"] = score;
        updates[pid + "/lastGain"] = gain;
    });

    await window.fb.update(playersRef, updates);
    await window.fb.update(gameRef, { phase: "reveal" });

    playSound("reveal");
    resetHostTimer();

    // compute counts and update host options UI to show counts and highlight correct
    const counts = Array((data.questions[idx].options || []).length).fill(0);
    Object.values(players || {}).forEach((p) => {
        if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
            counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
        }
    });

    const container = document.getElementById("hostOptionsContainer");
    Array.from(container.children).forEach((el, i) => {
        // update count badge if present
        const cnt = el.querySelector ? el.querySelector('.option-count') : null;
        if (cnt) cnt.textContent = String(counts[i] || 0);
        // mark correct/wrong visually
        if (i === correctIndex) {
            el.classList.add("correct");
            el.classList.remove("wrong");
            const badge = cnt; if (badge) badge.classList.add('correct');
        } else {
            if (counts[i] > 0) el.classList.add('wrong');
            const badge = cnt; if (badge) badge.classList.remove('correct');
        }
    });
}

async function endGame() {
    if (!currentGameId) return;
    const gameRef = window.fb.ref(`games/${currentGameId}`);
    await window.fb.update(gameRef, { phase: "ended" });
    playSound("end");
    resetHostTimer();
    alert("Game diakhiri. Terima kasih!");
    // clear persisted state
    clearLocalState();
}

// =============== PLAYER LOGIC ===============

async function joinGame() {
    const name = document.getElementById("playerNameInput").value.trim();
    const pin = document.getElementById("pinInput").value.trim();
    const errorEl = document.getElementById("playerJoinError");
    errorEl.textContent = "";

    if (!name || !pin) {
        errorEl.textContent = "Nama dan PIN wajib diisi.";
        return;
    }

    // require avatar selection
    const chosenAvatar = selectedAvatar || (loadLocalState() && loadLocalState().playerAvatar) || '';
    if (!chosenAvatar) {
        errorEl.textContent = 'Silakan pilih atau unggah ikon profil sebelum bergabung.';
        return;
    }

    const gamesRef = window.fb.ref("games");
    const gamesSnap = await window.fb.get(gamesRef);
    let gameId = null;
    const gamesVal = gamesSnap.val ? gamesSnap.val() : gamesSnap || {};
    Object.entries(gamesVal).forEach(([k, val]) => {
        if (val && val.pin === pin) gameId = k;
    });

    if (!gameId) {
        errorEl.textContent = "PIN tidak ditemukan.";
        return;
    }

    currentGameId = gameId;

    const playersRef = window.fb.ref(`games/${gameId}/players`);
    const newPlayerRef = window.fb.push(playersRef);
    const avatarToSave = selectedAvatar || (loadLocalState() && loadLocalState().playerAvatar) || '';
    await window.fb.set(newPlayerRef, {
        name,
        avatar: avatarToSave || '',
        score: 0,
        currentAnswer: null,
        answerTime: null,
        lastGain: null
    });
    currentPlayerId = newPlayerRef.key;

    // persist player state so refresh can reattach
    saveLocalState({ role: 'player', currentGameId: currentGameId, currentPlayerId, playerName: name, pin, playerAvatar: avatarToSave });

    document.getElementById("playerJoinCard").classList.add("hidden");
    document.getElementById("playerWaitingCard").classList.remove("hidden");
    setText("playerNameLabel", name);
    setText("playerGamePinLabel", pin);

    listenGameAsPlayer(gameId);
}

function listenGameAsPlayer(gameId) {
    const gameRef = window.fb.ref(`games/${gameId}`);
    window.fb.onValue(gameRef, (snap) => {
        const data = snap.val ? snap.val() : snap || {};
        if (!data) return;

        if (data.phase === "lobby") {
            // tetap menunggu
        } else if (data.phase === "starting") {
            // show waiting card and start countdown
            document.getElementById('playerJoinCard').classList.add('hidden');
            document.getElementById('playerSummaryCard').classList.add('hidden');
            document.getElementById('playerQuestionCard').classList.add('hidden');
            document.getElementById('playerWaitingCard').classList.remove('hidden');
            if (data.startingAt) startCountdown('playerCountdownLabel', data.startingAt, COUNTDOWN_MS, null);
        } else if (data.phase === "question") {
            showPlayerQuestion(data);
            resetPlayerTimer();
            if (data.questionStartAt) {
                startTimer("playerTimerLabel", data.questionStartAt, false);
            }
        } else if (data.phase === "reveal") {
            showPlayerReveal(data);
            resetPlayerTimer();
        } else if (data.phase === "ended") {
            showPlayerSummary(data);
            resetPlayerTimer();
        }
    });

    const playerRef = window.fb.ref(`games/${gameId}/players/${currentPlayerId}`);
    window.fb.onValue(playerRef, (snap) => {
        const data = snap.val ? snap.val() : snap || {};
        if (!data) return;

        // Update indikator skor di layar peserta
        if (data.lastGain != null) {
            setText("playerGainLabel", `Poin soal ini: +${data.lastGain}`);
        } else {
            setText("playerGainLabel", "");
        }
        setText("playerTotalScoreLabel", `Total skor: ${data.score || 0}`);
    });
}

async function showPlayerQuestion(gameData) {
    document.getElementById("playerWaitingCard").classList.add("hidden");
    document.getElementById("playerSummaryCard").classList.add("hidden");
    document.getElementById("playerQuestionCard").classList.remove("hidden");

    const idx = gameData.currentQuestionIndex;
    const q = gameData.questions[idx];

    setText("playerQuestionText", q.text);
    // render optional image for player
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
    setText("playerQuestionIndexLabel", idx + 1);
    setText("playerStatusLabel", "Pilih jawabanmu secepat mungkin!");
    setText("playerGainLabel", "");
    // total skor akan di-update dari listener playerRef

    const container = document.getElementById("playerOptionsContainer");
    clearElement(container);

    // stop any lingering feedback audio when a new question loads
    try {
        if (window._currentFeedbackAudio && typeof window._currentFeedbackAudio.pause === 'function') {
            try { window._currentFeedbackAudio.pause(); } catch (e) { }
            try { window._currentFeedbackAudio.currentTime = 0; } catch (e) { }
            window._currentFeedbackAudio = null;
        }
    } catch (e) { }

    // compute counts from gameData.players (if present)
    const counts = Array((q.options || []).length).fill(0);
    try {
        const playersObj = gameData.players || {};
        Object.values(playersObj).forEach((p) => {
            if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
                counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
            }
        });
    } catch (e) { }

    // try to read player's existing answer so we can reflect it in the UI
    let existingAnswer = null;
    try {
        if (currentGameId && currentPlayerId && window.fb && window.fb.get) {
            const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
            const snap = await window.fb.get(playerRef);
            const pdata = snap && snap.val ? snap.val() : snap || {};
            existingAnswer = (typeof pdata.currentAnswer === 'number') ? pdata.currentAnswer : null;
        }
    } catch (e) { /* ignore */ }

    q.options.forEach((opt, i) => {
        const btn = document.createElement("button");
        btn.className = "option-btn";
        btn.dataset.index = String(i);
        // left label
        const left = document.createElement('div'); left.style.flex = '1';
        left.textContent = String.fromCharCode(65 + i) + '. ' + opt;
        // count badge
        const cnt = document.createElement('div'); cnt.className = 'option-count'; cnt.textContent = String(counts[i] || 0);

        btn.appendChild(left);
        btn.appendChild(cnt);
        btn.onclick = () => submitAnswer(i, btn, container);

        // if player already answered, reflect it
        if (existingAnswer !== null && existingAnswer === i) {
            try {
                btn.classList.add('selected');
                btn.setAttribute('aria-pressed', 'true');
                btn.dataset.selected = '1';
                btn.disabled = true;
                // inline fallback style so it's visible immediately
                btn.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
                btn.style.borderColor = '#3b82f6';
                btn.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
            } catch (e) { }
        }
        container.appendChild(btn);
    });
}

function submitAnswer(choiceIndex, btn, container) {
    if (!currentGameId || !currentPlayerId) return;

    const label = document.getElementById("playerTimerLabel");
    const text = label.textContent.replace("s", "");
    const remaining = parseFloat(text);
    if (!isNaN(remaining) && remaining <= 0) {
        setText("playerStatusLabel", "Waktu habis, tunggu soal berikutnya.");
        return;
    }

    // determine container reliably (fallback to btn.parentElement)
    const containerEl = container || (btn && btn.parentElement) || document.getElementById('playerOptionsContainer');
    const selIndex = String(choiceIndex);
    console.log('submitAnswer: choiceIndex=', choiceIndex, 'btn.dataset.index=', btn && btn.dataset && btn.dataset.index);
    // mark selection visibly and disable other buttons; prefer matching by data-index so
    // remote updates or small DOM differences won't break element reference equality
    let matched = false;
    Array.from(containerEl.children).forEach((b) => {
        const bi = (b.dataset && b.dataset.index) ? String(b.dataset.index) : null;
        if (bi === selIndex) {
            matched = true;
            b.classList.add("selected");
            b.setAttribute('aria-pressed', 'true');
            b.dataset.selected = '1';
            // inline style fallback to force visible highlight immediately
            try {
                b.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
                b.style.borderColor = '#3b82f6';
                b.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
            } catch (e) { }
        } else {
            b.classList.remove("selected");
            b.removeAttribute('aria-pressed');
            delete b.dataset.selected;
            try {
                b.style.background = '';
                b.style.borderColor = '';
                b.style.boxShadow = '';
            } catch (e) { }
        }
        b.disabled = true;
    });

    // Fallback: if no child matched by data-index (e.g. DOM differences), ensure the
    // clicked element itself is marked selected so user always sees feedback.
    if (!matched && btn) {
        console.warn('submitAnswer: no child matched by data-index, applying selected to clicked element as fallback');
        try {
            btn.classList.add('selected');
            btn.setAttribute('aria-pressed', 'true');
            btn.dataset.selected = '1';
            btn.disabled = true;
            btn.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
            btn.style.borderColor = '#3b82f6';
            btn.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
        } catch (e) { /* ignore */ }
    }
    // force style reflow so highlight appears immediately
    void btn.offsetWidth;
    setText("playerStatusLabel", "Jawaban terkirim, tunggu host reveal.");

    const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
    window.fb.update(playerRef, {
        currentAnswer: choiceIndex,
        answerTime: window.fb.serverTimestamp()
    });
}

function showPlayerReveal(gameData) {
    // defensive: only proceed when gameData indicates reveal phase
    if (gameData && gameData.phase && gameData.phase !== 'reveal') return;
    const idx = gameData.currentQuestionIndex;
    const q = gameData.questions[idx];
    const correctIndex = q.correctIndex;

    // compute counts and update UI
    const counts = Array((q.options || []).length).fill(0);
    const playersObj = gameData.players || {};
    Object.values(playersObj).forEach((p) => {
        if (typeof p.currentAnswer === 'number' && p.currentAnswer >= 0 && p.currentAnswer < counts.length) {
            counts[p.currentAnswer] = (counts[p.currentAnswer] || 0) + 1;
        }
    });

    const container = document.getElementById("playerOptionsContainer");
    Array.from(container.children).forEach((btn, i) => {
        btn.disabled = true;
        // update badge if present
        const badge = btn.querySelector ? btn.querySelector('.option-count') : null;
        if (badge) badge.textContent = String(counts[i] || 0);
        if (i === correctIndex) {
            btn.classList.add("correct");
            if (badge) badge.classList.add('correct');
        } else {
            if (counts[i] > 0) btn.classList.add('wrong');
            if (badge) badge.classList.remove('correct');
        }
    });

    setText("playerStatusLabel", "Jawaban benar telah ditampilkan. Lihat poinmu lalu tunggu soal berikutnya.");

    // Play feedback audio for this player: success if their answer equals correctIndex
    try {
        const playersObj = gameData.players || {};
        const me = (currentPlayerId && playersObj[currentPlayerId]) ? playersObj[currentPlayerId] : null;
        const myAnswer = me && typeof me.currentAnswer === 'number' ? me.currentAnswer : null;
        const isSuccess = (myAnswer !== null && myAnswer === correctIndex);
        // only play when we have a current player id and phase is reveal
        if (currentPlayerId && gameData.phase === 'reveal') playRandomFeedback(!!isSuccess, gameData.phase);
    } catch (e) { console.warn('play feedback determination failed', e); }
}

// audio pools for feedback
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

function playRandomFeedback(isSuccess, passedPhase) {
    const knownPhase = passedPhase || (window.currentGameState && window.currentGameState.phase) || 'unknown';
    console.debug('playRandomFeedback called', { isSuccess, knownPhase, passedPhase, currentPlayerId });
    try {
        // strict guard: only play feedback when the phase passed in (or last known) is reveal
        if (knownPhase !== 'reveal') {
            console.debug('playRandomFeedback suppressed because phase is not reveal', { knownPhase });
            return;
        }
        const pool = isSuccess ? successAudios : failAudios;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        // stop previous feedback audio if any
        try {
            if (window._currentFeedbackAudio && typeof window._currentFeedbackAudio.pause === 'function') {
                window._currentFeedbackAudio.pause();
                try { window._currentFeedbackAudio.currentTime = 0; } catch (e) { }
            }
        } catch (e) { }
        const audio = new Audio(pick);
        window._currentFeedbackAudio = audio;
        audio.volume = isSuccess ? 0.9 : 0.9;
        audio.play().catch((e) => { console.warn('play feedback failed', e); });
    } catch (e) { console.warn('playRandomFeedback error', e); }
}

function showPlayerSummary(gameData) {
    document.getElementById("playerQuestionCard").classList.add("hidden");
    document.getElementById("playerWaitingCard").classList.add("hidden");
    document.getElementById("playerSummaryCard").classList.remove("hidden");

    const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
    window.fb.get(playerRef).then((snap) => {
        const data = snap.val ? snap.val() : snap || {};
        setText("playerFinalScore", data ? (data.score || 0) : 0);
    });
}

function joinAnotherGame() {
    // keep the player's name if available
    const stored = loadLocalState() || {};
    const nameFromLabel = document.getElementById('playerNameLabel') ? document.getElementById('playerNameLabel').textContent : '';
    const name = stored.playerName || document.getElementById('playerNameInput').value || nameFromLabel || '';

    // clear current game/player identifiers
    currentGameId = null;
    currentPlayerId = null;

    // persist minimal state (role + name) so refresh keeps name prefilled
    saveLocalState({ role: 'player', playerName: name });

    // show join form
    document.getElementById('playerSummaryCard').classList.add('hidden');
    document.getElementById('playerWaitingCard').classList.add('hidden');
    document.getElementById('playerQuestionCard').classList.add('hidden');
    document.getElementById('playerJoinCard').classList.remove('hidden');
    document.getElementById('pinInput').value = '';
    document.getElementById('playerNameInput').value = name;
    setText('playerJoinError', '');
}

// show confirmation before leaving current game
function confirmAndJoinAnotherGame() {
    const ok = confirm('Are you sure you want to leave this game and join another?');
    if (ok) joinAnotherGame();
}

// Delegated click fallback: ensure any clicked element with .option-btn is handled
// This helps when the page loaded an older version of the script or DOM differences
// — it guarantees the user sees immediate feedback and the answer is sent.
document.addEventListener('click', (ev) => {
    try {
        const el = ev.target && ev.target.closest ? ev.target.closest('.option-btn') : null;
        if (!el) return;
        // If already marked selected by primary handler, do nothing
        if (el.dataset && el.dataset.selected === '1') return;

        const container = el.parentElement || document.getElementById('playerOptionsContainer');
        if (!container) return;

        // mark selection and disable siblings
        Array.from(container.children).forEach((b) => {
            if (b === el) {
                b.classList.add('selected');
                b.setAttribute('aria-pressed', 'true');
                b.dataset.selected = '1';
                try {
                    b.style.background = 'linear-gradient(180deg, rgba(59,130,246,0.08), #1e3a8a)';
                    b.style.borderColor = '#3b82f6';
                    b.style.boxShadow = '0 6px 18px rgba(59,130,246,0.06), inset 0 0 0 3px rgba(59,130,246,0.03)';
                } catch (e) { }
            } else {
                b.classList.remove('selected');
                b.removeAttribute('aria-pressed');
                delete b.dataset.selected;
                try { b.style.background = ''; b.style.borderColor = ''; b.style.boxShadow = ''; } catch (e) { }
            }
            try { b.disabled = true; } catch (e) { }
        });

        console.log('delegated click: option selected, index=', el.dataset && el.dataset.index);
        setText('playerStatusLabel', 'Jawaban terkirim, tunggu host reveal.');

        // If player context available, send answer to Firebase (best-effort)
        try {
            const idx = (el.dataset && typeof el.dataset.index !== 'undefined') ? parseInt(el.dataset.index, 10) : null;
            if (idx !== null && currentGameId && currentPlayerId && window.fb && window.fb.update) {
                const playerRef = window.fb.ref(`games/${currentGameId}/players/${currentPlayerId}`);
                window.fb.update(playerRef, { currentAnswer: idx, answerTime: window.fb.serverTimestamp() });
            }
        } catch (e) { /* ignore */ }
    } catch (e) { console.warn('delegated click handler error', e); }
});
