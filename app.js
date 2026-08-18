/* ============================================================
   EatSoon — Lean MVP prototype
   REGISTER → REMIND → RECOMMEND → CONSUME
   모든 상태는 localStorage에만 저장됩니다 (서버 없음).
   ============================================================ */

const STORE_KEY = 'eatsoon.v1';
const URGENT_DAYS = 2;              // D-2 부터 "임박"
const KPI_TARGET = { consume: 70, open: 80, recipe: 60, funnel: 85 };

/* ── State ─────────────────────────────────────────── */
const emptyState = () => ({ items: [], events: [], notified: {}, customRecipes: [] });
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      notified: parsed.notified && typeof parsed.notified === 'object' ? parsed.notified : {},
      customRecipes: Array.isArray(parsed.customRecipes) ? parsed.customRecipes : []
    };
  } catch {
    return emptyState();
  }
}

function save() {
  if (state.events.length > 400) state.events = state.events.slice(-400);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    toast('저장 공간이 가득 찼습니다.');
  }
}

function log(type, meta) {
  state.events.push({ type, meta: meta || null, at: Date.now() });
  save();
}

/* ── Date helpers ──────────────────────────────────── */
const DAY = 86400000;

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function toISO(d) {
  const x = startOfDay(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function parseISO(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
/** 남은 일수. 0 = 오늘이 소비기한, 음수 = 경과 */
function dday(item) {
  return Math.round((startOfDay(parseISO(item.expiry)) - startOfDay(new Date())) / DAY);
}
function ddayLabel(n) {
  if (n === 0) return 'D-DAY';
  return n > 0 ? `D-${n}` : `+${Math.abs(n)}일 경과`;
}
function formatDate(s) {
  const d = parseISO(s);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ── Domain helpers ────────────────────────────────── */
function emojiLookup(text) {
  const hit = EMOJI_MAP.find(([key]) => text.includes(key));
  return hit ? hit[1] : null;
}
function emojiFor(name) {
  return emojiLookup(name) || '🍽️';
}
const activeItems = () => state.items.filter(i => i.status === 'active');
const resolvedItems = () => state.items.filter(i => i.status !== 'active');
const urgentItems = () => activeItems().filter(i => dday(i) <= URGENT_DAYS).sort((a, b) => dday(a) - dday(b));

function itemById(id) {
  return state.items.find(i => i.id === id);
}

/** 기본 레시피 + 사용자가 직접 만든 레시피 */
function allRecipes() {
  return RECIPES.concat(state.customRecipes);
}
function recipeById(id) {
  return allRecipes().find(r => r.id === id);
}

/* ============================================================
   RECOMMEND ENGINE — 남은 재료로 만들 수 있는 요리
   ============================================================ */

/** 사용자가 등록한 재료명이 레시피의 표준 태그와 같은 재료인가 */
function nameMatchesTag(name, tag) {
  const n = name.replace(/\s/g, '');
  const candidates = [tag, ...(SYNONYMS[tag] || [])];
  return candidates.some(c => {
    if (n.includes(c)) return true;
    // "우유" 항목이 "무가당우유" 태그를 덮는 경우 — 짧은 이름의 오매칭 방지
    return n.length >= 2 && c.includes(n);
  });
}

/** 레시피의 재료를 보유/부족으로 나눕니다 */
function matchInfo(recipe, names) {
  const matched = [];
  const missing = [];
  recipe.tags.forEach(tag => {
    if (names.some(n => nameMatchesTag(n, tag))) matched.push(tag);
    else missing.push(tag);
  });
  return { matched, missing };
}

/**
 * 재료 목록으로 레시피를 점수화합니다.
 * - 보유 재료를 많이 쓸수록  ↑
 * - 임박(D-2) 재료를 쓰면    ↑↑
 * - 부족한 재료가 많을수록   ↓
 * - 조리 시간이 짧을수록     ↑
 */
function scoreRecipes(names, urgentNames = []) {
  return allRecipes()
    .map(recipe => {
      const { matched, missing } = matchInfo(recipe, names);
      const urgentUsed = matched.filter(tag => urgentNames.some(n => nameMatchesTag(n, tag)));
      const ratio = recipe.tags.length ? matched.length / recipe.tags.length : 0;
      const score =
        matched.length * 10 +
        urgentUsed.length * 25 +
        ratio * 20 -
        missing.length * 4 -
        recipe.minutes * 0.2;
      return { recipe, matched, missing, urgentUsed, ratio, score };
    })
    .filter(x => x.matched.length > 0)
    .sort((a, b) => b.score - a.score);
}

/** 냉장고 전체 기준 추천 */
function recommendations(limit) {
  const names = activeItems().map(i => i.name);
  const urgentNames = urgentItems().map(i => i.name);
  const list = scoreRecipes(names, urgentNames);
  return limit ? list.slice(0, limit) : list;
}

/* ============================================================
   ROUTER
   ============================================================ */
const ROUTES = ['overview', 'home', 'add', 'recipes', 'stats'];

function currentRoute() {
  const hash = location.hash.replace('#/', '');
  return ROUTES.includes(hash) ? hash : 'overview';
}

function renderRoute() {
  const route = currentRoute();
  document.querySelectorAll('.screen').forEach(el => {
    el.classList.toggle('is-active', el.dataset.screen === route);
  });
  document.querySelectorAll('.sub-nav__tab').forEach(tab => {
    if (tab.dataset.route === route) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });

  if (route === 'add') {
    log('register_start');
    renderAdd();
  }
  if (route === 'recipes') {
    log('recipe_list_view', { source: 'tab' });
    renderRecipes();
  }
  if (route === 'overview') renderOverview();
  if (route === 'home') renderHome();
  if (route === 'stats') renderStats();

  window.scrollTo({ top: 0, behavior: 'auto' });
}

window.addEventListener('hashchange', renderRoute);

/* ============================================================
   HOME
   ============================================================ */
function renderHome() {
  const urgent = urgentItems();
  const active = activeItems().slice().sort((a, b) => dday(a) - dday(b));
  const done = resolvedItems().slice().reverse();

  /* Hero */
  const heroTitle = document.getElementById('heroTitle');
  const heroLead = document.getElementById('heroLead');
  const heroEyebrow = document.getElementById('heroEyebrow');
  const heroEmoji = document.getElementById('heroEmoji');

  if (urgent.length) {
    const top = urgent[0];
    const n = dday(top);
    heroEyebrow.textContent = '소비 골든타임';
    heroTitle.textContent = `${urgent.length}개, 지금 먹어야 해요`;
    heroLead.textContent = n < 0
      ? `${top.name}은(는) 소비기한이 ${Math.abs(n)}일 지났어요. 상태를 확인해 주세요.`
      : `${top.name}의 소비기한이 ${n === 0 ? '오늘까지예요' : `${n}일 남았어요`}. 상하기 전에 드세요.`;
    heroEmoji.textContent = top.emoji;
  } else if (active.length) {
    heroEyebrow.textContent = '오늘의 냉장고';
    heroTitle.textContent = '임박한 식재료가 없어요';
    heroLead.textContent = `${active.length}개를 보관 중이에요. 소비기한 2일 전에 알려드릴게요.`;
    heroEmoji.textContent = active[0].emoji;
  } else {
    heroEyebrow.textContent = '오늘의 냉장고';
    heroTitle.textContent = '냉장고가 비어 있어요';
    heroLead.textContent = '식재료를 등록하면 소비기한 2일 전에 알려드릴게요.';
    heroEmoji.textContent = '🧊';
  }

  /* 남은 재료 기반 추천 (상위 3) */
  const reco = recommendations(3);

  /* Urgent list */
  const urgentTile = document.getElementById('urgentTile');
  urgentTile.hidden = urgent.length === 0;
  document.getElementById('urgentList').replaceChildren(...urgent.map(itemCard));

  /* All items */
  const allList = document.getElementById('allList');
  const empty = document.getElementById('emptyState');
  allList.replaceChildren(...active.map(itemCard));
  empty.hidden = active.length > 0;
  document.getElementById('allSubcopy').textContent = active.length
    ? `보관 중 ${active.length}개 · 임박 ${urgent.length}개`
    : '보관 중인 식재료를 한눈에.';

  /* 남은 재료 기반 추천 타일 */
  const recoTile = document.getElementById('homeRecoTile');
  recoTile.hidden = reco.length === 0;
  document.getElementById('homeRecoList').replaceChildren(...reco.map(recipeCard));

  /* Resolved */
  const doneTile = document.getElementById('doneTile');
  doneTile.hidden = done.length === 0;
  document.getElementById('doneList').replaceChildren(...done.map(i => {
    const chip = document.createElement('span');
    chip.className = 'chip chip--static';
    chip.textContent = `${i.emoji} ${i.name} · ${i.status === 'eaten' ? '먹었어요 ✅' : '버렸어요 ❌'}`;
    return chip;
  }));

  /* Notification permission button */
  const permBtn = document.getElementById('btnPermission');
  permBtn.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

/* ============================================================
   OVERVIEW (홈) — 임박 식재료 / 레시피 추천 / 소비율을 한눈에
   임박 식재료·레시피 추천을 먼저 강조하고, 소비율은 가장 덜 중요한
   지표라 맨 오른쪽에 배치합니다.
   ============================================================ */
function renderOverview() {
  const urgent = urgentItems();
  const reco = recommendations(3);

  const grid = document.getElementById('overviewGrid');
  const empty = document.getElementById('overviewEmpty');
  const hasItems = state.items.length > 0;
  grid.hidden = !hasItems;
  empty.hidden = hasItems;
  if (!hasItems) return;

  const urgentCard = document.createElement('article');
  urgentCard.className = 'kpi-card kpi-card--accent';
  urgentCard.innerHTML = `
    <p class="kpi-card__label">임박 식재료</p>
    <p class="kpi-card__value">⏰ ${urgent.length}개</p>
    <p class="kpi-card__target">${urgent.length ? `${urgent[0].name} 외 · 지금 확인하세요` : '임박한 재료가 없어요'}</p>`;

  const recoCard = document.createElement('article');
  recoCard.className = 'kpi-card kpi-card--accent';
  recoCard.innerHTML = `
    <p class="kpi-card__label">해결 레시피 추천</p>
    <p class="kpi-card__value">🍳 ${reco.length}개</p>
    <p class="kpi-card__target">${reco.length ? `${reco[0].recipe.title} 등 지금 만들 수 있어요` : '재료를 등록하면 추천해드려요'}</p>`;

  const consumeCard = kpiCard(computeKPI().consume);

  makeCardClickable(urgentCard, () => {
    location.hash = '#/home';
    setTimeout(() => {
      const t = document.getElementById('urgentTile');
      if (t && !t.hidden) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  });
  makeCardClickable(recoCard, () => { location.hash = '#/recipes'; });
  makeCardClickable(consumeCard, () => { location.hash = '#/stats'; });

  grid.replaceChildren(urgentCard, recoCard, consumeCard);
}

/** 카드를 클릭/엔터로 활성화되는 링크처럼 만듭니다 (홈 바로가기 카드용) */
function makeCardClickable(el, onActivate) {
  el.classList.add('kpi-card--link');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.addEventListener('click', onActivate);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
  });
}

function itemCard(item) {
  const n = dday(item);
  const card = document.createElement('article');
  card.className = 'item-card';

  const head = document.createElement('div');
  head.className = 'item-card__head';
  head.innerHTML = `
    <div class="item-card__emoji">${item.emoji}</div>
    <div>
      <p class="item-card__name"></p>
      <p class="item-card__meta">소비기한 ${formatDate(item.expiry)}</p>
    </div>`;
  head.querySelector('.item-card__name').textContent = item.name;

  const badge = document.createElement('span');
  badge.className = 'dday' + (n < 0 ? ' dday--over' : n <= URGENT_DAYS ? ' dday--urgent' : '');
  badge.textContent = ddayLabel(n);
  head.appendChild(badge);

  const actions = document.createElement('div');
  actions.className = 'item-card__actions';

  const recipeBtn = document.createElement('button');
  recipeBtn.type = 'button';
  recipeBtn.className = 'btn btn--primary item-card__recipe-btn';
  recipeBtn.textContent = '레시피 보기';
  recipeBtn.addEventListener('click', () => openItemSheet(item.id));

  const consumeRowEl = document.createElement('div');
  consumeRowEl.className = 'item-card__consume-row';

  const eatBtn = document.createElement('button');
  eatBtn.type = 'button';
  eatBtn.className = 'btn btn--primary btn--sm';
  eatBtn.textContent = '✅ 먹었어요';
  eatBtn.addEventListener('click', () => { resolveItem(item.id, 'eaten'); closeSheet(); });

  const dropBtn = document.createElement('button');
  dropBtn.type = 'button';
  dropBtn.className = 'btn btn--secondary-pill btn--sm';
  dropBtn.textContent = '❌ 버렸어요';
  dropBtn.addEventListener('click', () => { resolveItem(item.id, 'discarded'); closeSheet(); });

  const partialBtn = document.createElement('button');
  partialBtn.type = 'button';
  partialBtn.className = 'btn btn--secondary-pill btn--sm';
  partialBtn.textContent = '🍽️ 일부 먹었어요';
  partialBtn.addEventListener('click', () => logPartialConsume(item.id));

  consumeRowEl.append(eatBtn, dropBtn, partialBtn);
  actions.append(recipeBtn, consumeRowEl);
  card.append(head, actions);
  return card;
}

/** STEP 04. 소비 전환 KPI 기록 */
function resolveItem(id, status) {
  const item = itemById(id);
  if (!item || item.status !== 'active') return;
  item.status = status;
  item.resolvedAt = Date.now();
  item.resolvedDday = dday(item);
  log(status === 'eaten' ? 'consume_eaten' : 'consume_discarded', { name: item.name, dday: item.resolvedDday });
  save();
  pushQueue = pushQueue.filter(pid => pid !== id);
  showNextPush();
  renderHome();
  toast(status === 'eaten' ? `${item.name}, 잘 드셨어요! 🎉` : `${item.name}, 다음엔 더 빨리 알려드릴게요.`);
}

/** 일부만 소비 — 상태는 active로 유지(목록에 남김), 이벤트만 기록합니다.
    주 KPI 공식(eaten÷reached)은 건드리지 않고, 클릭 수 자체를 별도 참고 지표로 둡니다. */
function logPartialConsume(id) {
  const item = itemById(id);
  if (!item || item.status !== 'active') return;
  log('consume_partial', { name: item.name, dday: dday(item) });
  save();
  if (currentRoute() === 'home') renderHome();
  toast('남은 음식도 기한 내에 처리하도록 도울게요.');
}

/* ============================================================
   ADD  (STEP 01. REGISTER)
   ============================================================ */
const QUICK_NAMES = ['우유', '계란', '두부', '대파', '양파', '김치', '식빵', '요거트', '닭가슴살', '치즈'];

/** 식재료명 → 기본 소비기한 일수. 매칭 안 되면 기존 기본값(3일)을 씁니다. */
function suggestedExpiryDays(name) {
  const hit = SHELF_LIFE_DAYS.find(([key]) => name.includes(key));
  return hit ? hit[1] : 3;
}

/** 이름 입력을 바탕으로 소비기한을 자동 제안합니다 (사용자가 날짜를 직접 건드리기 전까지만). */
function applyDateSuggestion(name) {
  const hint = document.getElementById('dateHint');
  if (dateTouchedByUser || !name) {
    return;
  }
  const days = suggestedExpiryDays(name);
  document.getElementById('fDate').value = toISO(new Date(Date.now() + days * DAY));
  const hit = SHELF_LIFE_DAYS.find(([key]) => name.includes(key));
  if (hit) {
    hint.textContent = `"${name}" 기준으로 소비기한을 ${days}일 뒤로 자동 제안했어요. 실제 포장에 표시된 기한으로 꼭 확인해 주세요.`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

let dateTouchedByUser = false;

function renderAdd() {
  const wrap = document.getElementById('quickNames');
  if (!wrap.childElementCount) {
    wrap.replaceChildren(...QUICK_NAMES.map(name => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = `${emojiFor(name)} ${name}`;
      chip.addEventListener('click', () => {
        document.getElementById('fName').value = name;
        document.getElementById('formError').hidden = true;
        applyDateSuggestion(name);
      });
      return chip;
    }));
  }
  document.getElementById('addForm').reset();
  document.getElementById('formError').hidden = true;
  document.getElementById('dateHint').hidden = true;
  dateTouchedByUser = false;
  const dateInput = document.getElementById('fDate');
  dateInput.min = toISO(new Date(Date.now() - 30 * DAY));
  dateInput.value = toISO(new Date(Date.now() + 3 * DAY));
}

document.getElementById('fName').addEventListener('input', e => {
  applyDateSuggestion(e.target.value.trim());
});

document.getElementById('fDate').addEventListener('input', () => {
  dateTouchedByUser = true;
  document.getElementById('dateHint').hidden = true;
});

document.getElementById('quickDates').addEventListener('click', e => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;
  dateTouchedByUser = true;
  document.getElementById('dateHint').hidden = true;
  document.getElementById('fDate').value = toISO(new Date(Date.now() + Number(btn.dataset.days) * DAY));
});

/** 사진 파일 → 리사이즈된 JPEG base64 (긴 변 1024px 이하로 줄여서 업로드/토큰 절약) */
function resizeImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('이미지를 열지 못했습니다.'));
      img.onload = () => {
        const maxSide = 1024;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

document.getElementById('fPhoto').addEventListener('change', async e => {
  const file = e.target.files[0];
  const status = document.getElementById('photoStatus');
  if (!file) return;

  status.hidden = false;
  status.textContent = '사진에서 정보를 읽는 중...';
  try {
    const base64 = await resizeImageToBase64(file);
    const res = await fetch('/api/scan-expiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, mimeType: 'image/jpeg' })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '인식에 실패했습니다.');
    }
    const { result } = await res.json();

    if (result.name) document.getElementById('fName').value = result.name;
    if (result.expiry) document.getElementById('fDate').value = result.expiry;

    status.textContent = (result.name || result.expiry)
      ? '인식된 내용을 채웠어요. 확인하고 등록해 주세요.'
      : '사진에서 정보를 찾지 못했어요. 직접 입력해 주세요.';
    log('photo_scan_result', { found: Boolean(result.name || result.expiry) });
  } catch (err) {
    status.textContent = err.message || '인식에 실패했어요. 직접 입력해 주세요.';
  } finally {
    e.target.value = '';
  }
});

document.getElementById('addForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = document.getElementById('fName').value.trim();
  const expiry = document.getElementById('fDate').value;
  const err = document.getElementById('formError');

  if (!name) {
    err.textContent = '식재료명을 입력해 주세요.';
    err.hidden = false;
    return;
  }
  if (!expiry) {
    err.textContent = '소비기한을 선택해 주세요.';
    err.hidden = false;
    return;
  }
  err.hidden = true;

  state.items.push({
    id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    emoji: emojiFor(name),
    expiry,
    createdAt: Date.now(),
    status: 'active'
  });
  log('register_complete', { name, expiry });
  save();

  toast(`${name} 등록 완료 · ${ddayLabel(dday({ expiry }))}`);
  location.hash = '#/home';
  checkNotifications();
});

/* ============================================================
   RECIPES  (STEP 03. RECOMMEND)
   ============================================================ */
let recipeFilter = null;
let recipeShowAll = false;

function renderRecipes() {
  const names = [...new Set(activeItems().map(i => i.name))];

  /* 전체 레시피 DB 기준 재료 태그 — 내 냉장고에 없는 것도 둘러볼 수 있게 전부 노출.
     보유 중인 재료를 앞쪽에, 나머지는 가나다순으로 정렬합니다. */
  const allTags = [...new Set(allRecipes().flatMap(r => r.tags))].sort((a, b) => {
    const aOwned = names.includes(a) ? 0 : 1;
    const bOwned = names.includes(b) ? 0 : 1;
    return aOwned !== bOwned ? aOwned - bOwned : a.localeCompare(b, 'ko');
  });

  /* 사라진 대상(삭제된 내 레시피 / DB에 없는 태그)을 가리키는 필터는 해제 */
  if (recipeFilter === '@mine' && !state.customRecipes.length) recipeFilter = null;
  else if (recipeFilter && recipeFilter !== '@mine' && !allTags.includes(recipeFilter)) recipeFilter = null;

  /* ① 남은 재료 기반 추천 */
  const reco = recommendations(6);
  document.getElementById('recoList').replaceChildren(...reco.map(recipeCard));
  document.getElementById('recoEmpty').hidden = reco.length > 0;

  /* ② 필터 칩 */
  const chips = [];
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'chip chip--sm';
  allChip.textContent = '전체';
  allChip.setAttribute('aria-pressed', String(recipeFilter === null));
  allChip.addEventListener('click', () => { recipeFilter = null; renderRecipes(); });
  chips.push(allChip);

  allTags.forEach(tag => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip chip--sm';
    chip.textContent = names.includes(tag) ? `✅ ${tag}` : tag;
    chip.setAttribute('aria-pressed', String(recipeFilter === tag));
    chip.addEventListener('click', () => { recipeFilter = recipeFilter === tag ? null : tag; renderRecipes(); });
    chips.push(chip);
  });

  if (state.customRecipes.length) {
    const mine = document.createElement('button');
    mine.type = 'button';
    mine.className = 'chip chip--sm';
    mine.textContent = `⭐ 내 레시피 ${state.customRecipes.length}`;
    mine.setAttribute('aria-pressed', String(recipeFilter === '@mine'));
    mine.addEventListener('click', () => { recipeFilter = recipeFilter === '@mine' ? null : '@mine'; renderRecipes(); });
    chips.push(mine);
  }
  document.getElementById('recipeFilters').replaceChildren(...chips);

  /* ③ 전체 목록 — 보유 재료와 안 겹치는 레시피는 기본적으로 접어두고, "더 보기"로 펼칩니다 */
  let list;
  let hiddenCount = 0;
  if (recipeFilter === '@mine') {
    list = state.customRecipes.map(r => ({ recipe: r, ...matchInfo(r, names), urgentUsed: [] }));
  } else if (recipeFilter) {
    list = scoreRecipes([recipeFilter]);
  } else {
    const scored = recommendations();
    const rest = allRecipes()
      .filter(r => !scored.some(s => s.recipe.id === r.id))
      .map(r => ({ recipe: r, ...matchInfo(r, names), urgentUsed: [] }));
    if (names.length === 0 || recipeShowAll) {
      list = scored.concat(rest);
    } else {
      list = scored;
      hiddenCount = rest.length;
    }
  }

  document.getElementById('recipeList').replaceChildren(...list.map(recipeCard));
  document.getElementById('recipeEmpty').hidden = list.length > 0;
  document.getElementById('recipeCount').textContent =
    `기본 ${RECIPES.length}종 · 내 레시피 ${state.customRecipes.length}종`;

  const showAllBtn = document.getElementById('recipeShowAllBtn');
  showAllBtn.hidden = hiddenCount === 0;
  showAllBtn.textContent = `보유 재료와 안 겹치는 레시피 ${hiddenCount}개 더 보기`;
}

document.getElementById('recipeShowAllBtn').addEventListener('click', () => {
  recipeShowAll = true;
  renderRecipes();
});

/** 추천/목록 카드. entry = { recipe, matched, missing, urgentUsed } */
function recipeCard(entry) {
  const { recipe } = entry;
  const matched = entry.matched || [];
  const missing = entry.missing || [];
  const urgentUsed = entry.urgentUsed || [];

  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'recipe-card';

  const badges = [];
  if (urgentUsed.length) badges.push(`<span class="badge badge--urgent">임박 ${urgentUsed.join('·')} 사용</span>`);
  if (matched.length && !missing.length) badges.push('<span class="badge badge--ready">바로 만들 수 있어요</span>');
  if (recipe.custom) badges.push('<span class="badge badge--mine">내 레시피</span>');

  card.innerHTML = `
    <div class="recipe-card__head">
      <span class="recipe-card__thumb">${recipe.emoji}</span>
      <div>
        <p class="recipe-card__title"></p>
        <p class="recipe-card__meta">약 ${recipe.minutes}분 · 재료 ${recipe.tags.length}가지</p>
      </div>
    </div>
    ${badges.length ? `<span class="badge-row">${badges.join('')}</span>` : ''}
    <span class="recipe-card__match">${matched.length ? `보유 재료 ${matched.length}개 사용 (${matched.join(', ')})` : '보유 재료와 겹치지 않아요'}</span>
    ${missing.length ? `<span class="recipe-card__missing">추가 재료: ${missing.join(', ')}</span>` : ''}`;
  card.querySelector('.recipe-card__title').textContent = recipe.title;
  card.addEventListener('click', () => openRecipeSheet(recipe.id, null));
  return card;
}

/* ============================================================
   내 레시피 추가 / 수정 / 삭제
   ============================================================ */

/** 재료 줄에서 표준 재료명을 뽑습니다. 한 줄에 하나(가장 긴 일치어). */
function extractTags(lines) {
  const vocab = [...INGREDIENT_VOCAB].sort((a, b) => b.length - a.length);
  const found = [];
  lines.forEach(line => {
    const hit = vocab.find(v => line.includes(v));
    const tag = hit || line.trim().split(/[\s,·]/)[0].replace(/[0-9].*$/, '').trim();
    if (tag && tag.length >= 1 && !found.includes(tag)) found.push(tag);
  });
  return found;
}

function openRecipeForm(editId) {
  const editing = editId ? state.customRecipes.find(r => r.id === editId) : null;

  sheetBody.replaceChildren();

  const head = document.createElement('div');
  head.innerHTML = `
    <p class="eyebrow">MY RECIPE</p>
    <h3 class="display-md" id="sheetTitle"></h3>
    <p class="body body--muted">직접 만든 레시피도 남은 재료 추천에 함께 반영됩니다.</p>`;
  head.querySelector('#sheetTitle').textContent = editing ? '내 레시피 수정' : '내 레시피 추가';
  sheetBody.appendChild(head);

  const form = document.createElement('form');
  form.className = 'form';
  form.style.marginTop = 'var(--lg)';
  form.noValidate = true;
  form.innerHTML = `
    <div class="field-row">
      <label class="field" style="margin-top:0">
        <span class="field__label">요리 이름</span>
        <input class="input" name="title" type="text" placeholder="예: 엄마표 계란볶음밥" maxlength="30" autocomplete="off">
      </label>
      <label class="field" style="margin-top:0; flex:0 0 140px">
        <span class="field__label">소요 시간(분)</span>
        <input class="input" name="minutes" type="number" min="1" max="180" placeholder="10">
      </label>
    </div>
    <label class="field">
      <span class="field__label">재료 — 한 줄에 하나씩</span>
      <textarea class="input input--area" name="ingredients" placeholder="계란 2개&#10;밥 1공기&#10;대파 1/2대"></textarea>
      <span class="field__hint">줄마다 재료명을 자동으로 인식해 추천에 사용합니다. 분량은 같이 적어도 됩니다.</span>
    </label>
    <label class="field">
      <span class="field__label">만드는 법 — 한 줄에 한 단계</span>
      <textarea class="input input--area" name="steps" placeholder="대파를 기름에 볶아 파기름을 냅니다.&#10;계란을 넣고 스크램블합니다.&#10;밥을 넣고 고루 볶습니다."></textarea>
    </label>
    <p class="form__error" hidden></p>
    <div class="cta-row cta-row--start">
      <button class="btn btn--primary" type="submit"></button>
      <button class="btn btn--secondary-pill" type="button" data-cancel>취소</button>
    </div>`;

  const err = form.querySelector('.form__error');
  form.querySelector('button[type="submit"]').textContent = editing ? '수정 저장' : '레시피 저장';

  /* form.title 은 HTMLElement.title 과 충돌하므로 선택자로 직접 잡습니다 */
  const fTitle = form.querySelector('[name="title"]');
  const fMinutes = form.querySelector('[name="minutes"]');
  const fIngredients = form.querySelector('[name="ingredients"]');
  const fSteps = form.querySelector('[name="steps"]');

  if (editing) {
    fTitle.value = editing.title;
    fMinutes.value = editing.minutes;
    fIngredients.value = editing.ingredients.join('\n');
    fSteps.value = editing.steps.join('\n');
  }

  form.querySelector('[data-cancel]').addEventListener('click', () => {
    if (editing) openRecipeSheet(editing.id, null);
    else closeSheet();
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const title = fTitle.value.trim();
    const minutes = Number(fMinutes.value) || 10;
    const ingredients = fIngredients.value.split('\n').map(s => s.trim()).filter(Boolean);
    const steps = fSteps.value.split('\n').map(s => s.trim()).filter(Boolean);

    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (!title) return fail('요리 이름을 입력해 주세요.');
    if (!ingredients.length) return fail('재료를 한 줄 이상 입력해 주세요.');
    if (!steps.length) return fail('만드는 법을 한 줄 이상 입력해 주세요.');
    err.hidden = true;

    const tags = extractTags(ingredients);
    const recipe = {
      id: editing ? editing.id : `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      emoji: emojiLookup(title) || emojiLookup(ingredients.join(' ')) || '🍽️',
      minutes,
      tags,
      ingredients,
      steps,
      custom: true,
      createdAt: editing ? editing.createdAt : Date.now()
    };

    if (editing) {
      const idx = state.customRecipes.findIndex(r => r.id === editing.id);
      state.customRecipes[idx] = recipe;
      log('custom_recipe_edit', { title });
    } else {
      state.customRecipes.push(recipe);
      log('custom_recipe_add', { title, tags: tags.join('·') });
    }
    save();
    closeSheet();
    if (currentRoute() === 'recipes') renderRecipes();
    if (currentRoute() === 'home') renderHome();
    toast(editing ? `"${title}" 수정 완료` : `"${title}" 레시피를 추가했어요.`);
  });

  sheetBody.appendChild(form);
  openSheet();
}

function deleteCustomRecipe(id) {
  const recipe = state.customRecipes.find(r => r.id === id);
  if (!recipe) return;
  if (!confirm(`"${recipe.title}" 레시피를 삭제할까요?`)) return;
  state.customRecipes = state.customRecipes.filter(r => r.id !== id);
  log('custom_recipe_delete', { title: recipe.title });
  save();
  closeSheet();
  if (currentRoute() === 'recipes') renderRecipes();
  if (currentRoute() === 'home') renderHome();
  toast('삭제했습니다.');
}

document.getElementById('btnAddRecipe').addEventListener('click', () => openRecipeForm(null));

/* ============================================================
   SHEET  (재료 → 추천 레시피 → 상세)
   ============================================================ */
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');

function openSheet() {
  sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  sheetBody.scrollTop = 0;
}
function closeSheet() {
  sheet.hidden = true;
  document.body.style.overflow = '';
}
document.getElementById('sheetClose').addEventListener('click', closeSheet);
document.getElementById('sheetBackdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !sheet.hidden) closeSheet();
});

/* ============================================================
   AI 레시피 — DB에 없는 재료를 위한 LLM 생성 (서버리스 함수 경유)
   ============================================================ */
const AI_RECIPE_ENDPOINT = '/api/generate-recipe';

async function askAIForRecipe(name, itemId) {
  const res = await fetch(AI_RECIPE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ingredientName: name })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'AI 레시피 생성에 실패했습니다.');
  }
  const { recipe } = await res.json();
  const saved = {
    id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: recipe.title,
    emoji: recipe.emoji || emojiLookup(recipe.title) || '🍽️',
    minutes: recipe.minutes || 10,
    tags: recipe.tags,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    custom: true,
    aiGenerated: true,
    createdAt: Date.now()
  };
  state.customRecipes.push(saved);

  /* 기본 이모지 매칭에 없던 재료였을 가능성이 높으니, AI가 고른 이모지로 갱신 */
  if (itemId) {
    const item = itemById(itemId);
    if (item) item.emoji = saved.emoji;
  }

  log('ai_recipe_generated', { name, title: saved.title });
  save();
  if (itemId && currentRoute() === 'home') renderHome();
  return saved;
}

/** "AI에게 레시피 물어보기" 버튼 — 클릭 시 생성하고 바로 상세로 이동 */
function askAIButton(name, itemId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--primary';
  btn.textContent = '🤖 AI에게 레시피 물어보기';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '레시피 만드는 중...';
    try {
      const recipe = await askAIForRecipe(name, itemId);
      toast(`AI가 "${recipe.title}" 레시피를 만들었어요.`);
      openRecipeSheet(recipe.id, itemId);
    } catch (e) {
      toast(e.message || 'AI 레시피 생성에 실패했습니다.');
      btn.disabled = false;
      btn.textContent = '🤖 AI에게 레시피 물어보기';
    }
  });
  return btn;
}

/** 특정 식재료의 추천 레시피 + 소비 판단 버튼 */
function openItemSheet(itemId) {
  const item = itemById(itemId);
  if (!item) return;
  const list = scoreRecipes([item.name], [item.name]).slice(0, 4);
  log('recipe_list_view', { source: 'item', name: item.name });

  sheetBody.replaceChildren();

  const hero = document.createElement('div');
  hero.className = 'sheet__hero';
  hero.innerHTML = `
    <div class="sheet__thumb">${item.emoji}</div>
    <div>
      <h3 class="display-md" id="sheetTitle"></h3>
      <p class="body body--muted">소비기한 ${formatDate(item.expiry)} · ${ddayLabel(dday(item))}</p>
    </div>`;
  hero.querySelector('#sheetTitle').textContent = `${item.name} 활용하기`;
  sheetBody.appendChild(hero);

  const section = document.createElement('div');
  section.className = 'sheet__section';
  section.innerHTML = '<h4>추천 레시피</h4>';

  if (list.length) {
    const grid = document.createElement('div');
    grid.className = 'flow';
    list.forEach(({ recipe, missing }) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'flow__step';
      row.style.cursor = 'pointer';
      row.style.textAlign = 'left';
      row.style.width = '100%';
      row.innerHTML = `
        <span class="flow__no">${recipe.emoji}</span>
        <div>
          <p class="body-strong"></p>
          <p class="body body--muted">약 ${recipe.minutes}분 · ${missing.length ? `추가 재료: ${missing.join(', ')}` : '지금 재료로 바로 가능'}</p>
        </div>`;
      row.querySelector('.body-strong').textContent = recipe.title;
      row.addEventListener('click', () => openRecipeSheet(recipe.id, itemId));
      grid.appendChild(row);
    });
    section.appendChild(grid);
  } else {
    const p = document.createElement('p');
    p.className = 'body body--muted';
    p.textContent = '이 재료에 맞는 레시피가 아직 없어요. AI에게 바로 물어보거나, 레시피 탭에서 직접 추가할 수 있습니다.';
    section.appendChild(p);
    section.appendChild(askAIButton(item.name, itemId));
  }
  sheetBody.appendChild(section);
  sheetBody.appendChild(consumeBlock(item));
  openSheet();
}

/** STEP 04. KPI 측정 버튼
    재료명(withLabel=true면 이름도 같이) + 먹었어요/버렸어요/일부 먹었어요 버튼 한 줄.
    onDone(row)이 주어지면 각 버튼 클릭 후 호출됩니다 — 시트를 닫을지/이 줄만 지울지는 호출부가 결정합니다. */
function consumeRow(item, withLabel, onDone) {
  const row = document.createElement('div');
  row.className = 'cta-row cta-row--start';

  if (withLabel) {
    const label = document.createElement('span');
    label.className = 'body-strong';
    label.style.marginRight = 'auto';
    label.textContent = `${item.emoji} ${item.name}`;
    row.appendChild(label);
  }

  const act = status => {
    if (status === 'partial') logPartialConsume(item.id);
    else resolveItem(item.id, status);
    if (onDone) onDone(row);
  };

  const eat = document.createElement('button');
  eat.type = 'button';
  eat.className = 'btn btn--primary btn--sm';
  eat.textContent = '✅ 먹었어요';
  eat.addEventListener('click', () => act('eaten'));

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'btn btn--secondary-pill btn--sm';
  drop.textContent = '❌ 버렸어요';
  drop.addEventListener('click', () => act('discarded'));

  const partial = document.createElement('button');
  partial.type = 'button';
  partial.className = 'btn btn--secondary-pill btn--sm';
  partial.textContent = '🍽️ 일부 먹었어요';
  partial.addEventListener('click', () => act('partial'));

  row.append(eat, drop, partial);
  return row;
}

function consumeBlock(item) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet__section';
  wrap.innerHTML = '<h4>식재료를 어떻게 처리하셨나요?</h4>';
  wrap.appendChild(consumeRow(item, false, () => closeSheet()));
  return wrap;
}

/** 특정 재료 하나가 아니라, 이 레시피에 쓰인 보유 재료 여러 개를 한 번에 처리.
    하나 처리하면 그 줄만 지우고 시트는 유지, 마지막 하나였다면 시트를 닫습니다. */
function consumeBlockMulti(items) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet__section';
  wrap.innerHTML = '<h4>이 레시피에 쓴 재료, 어떻게 하셨나요?</h4>';

  const list = document.createElement('div');
  list.className = 'flow';
  items.forEach(item => {
    const row = consumeRow(item, true, rowEl => {
      rowEl.remove();
      if (!list.children.length) closeSheet();
    });
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

function openRecipeSheet(recipeId, itemId) {
  const recipe = recipeById(recipeId);
  if (!recipe) return;
  log('recipe_detail_open', { title: recipe.title });

  const names = activeItems().map(i => i.name);
  const { matched, missing } = matchInfo(recipe, names);

  sheetBody.replaceChildren();

  if (itemId) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'link-on-dark';
    back.style.color = 'var(--primary)';
    back.textContent = '← 추천 목록으로';
    back.addEventListener('click', () => openItemSheet(itemId));
    sheetBody.appendChild(back);
  }

  const hero = document.createElement('div');
  hero.className = 'sheet__hero';
  hero.innerHTML = `
    <div class="sheet__thumb">${recipe.emoji}</div>
    <div>
      ${recipe.custom ? '<span class="badge badge--mine">내 레시피</span>' : ''}
      <h3 class="display-md" id="sheetTitle"></h3>
      <p class="body body--muted">약 ${recipe.minutes}분 · 재료 ${recipe.tags.length}가지</p>
    </div>`;
  hero.querySelector('#sheetTitle').textContent = recipe.title;
  sheetBody.appendChild(hero);

  /* 재료 — 분량과 보유/추가필요 상태를 한 목록에 함께 표시 */
  const ing = document.createElement('div');
  ing.className = 'sheet__section';
  ing.innerHTML = '<h4>재료</h4>';
  const chipRow = document.createElement('div');
  chipRow.className = 'chip-row';
  recipe.ingredients.forEach(text => {
    const chip = document.createElement('span');
    chip.className = 'chip chip--static';
    if (names.length && matched.some(tag => text.includes(tag))) {
      chip.textContent = `✅ ${text}`;
    } else if (names.length && missing.some(tag => text.includes(tag))) {
      chip.style.opacity = '0.55';
      chip.textContent = `${text} (추가 필요)`;
    } else {
      chip.textContent = text;
    }
    chipRow.appendChild(chip);
  });
  ing.appendChild(chipRow);
  sheetBody.appendChild(ing);

  const steps = document.createElement('div');
  steps.className = 'sheet__section';
  steps.innerHTML = '<h4>만드는 법</h4>';
  const ol = document.createElement('ol');
  ol.className = 'sheet__steps';
  recipe.steps.forEach(s => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = s;
    li.appendChild(span);
    ol.appendChild(li);
  });
  steps.appendChild(ol);
  sheetBody.appendChild(steps);

  /* 내 레시피면 수정/삭제 */
  if (recipe.custom) {
    const tools = document.createElement('div');
    tools.className = 'cta-row cta-row--start';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn--pearl';
    edit.textContent = '수정';
    edit.addEventListener('click', () => openRecipeForm(recipe.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn--pearl';
    del.textContent = '삭제';
    del.addEventListener('click', () => deleteCustomRecipe(recipe.id));
    tools.append(edit, del);
    sheetBody.appendChild(tools);
  }

  const item = itemId ? itemById(itemId) : null;
  if (item && item.status === 'active') {
    sheetBody.appendChild(consumeBlock(item));
  } else if (!itemId && matched.length) {
    /* 특정 재료를 짚어서 들어온 게 아니어도, 이 레시피가 쓰는 보유 재료가 있으면 바로 처리할 수 있게.
       같은 이름의 재료를 여러 개 등록했다면 소비기한이 가장 임박한 것 하나로만 대표시켜 중복 표시를 막습니다. */
    const matchedItems = activeItems().filter(i => matched.some(tag => nameMatchesTag(i.name, tag)));
    const uniqueMatchedItems = Object.values(
      matchedItems.reduce((byName, i) => {
        if (!byName[i.name] || dday(i) < dday(byName[i.name])) byName[i.name] = i;
        return byName;
      }, {})
    );
    if (uniqueMatchedItems.length) sheetBody.appendChild(consumeBlockMulti(uniqueMatchedItems));
  }

  openSheet();
}

/* ============================================================
   REMIND  (STEP 02. 알림)
   ============================================================ */
const pushEl = document.getElementById('push');
let pushQueue = [];

function checkNotifications() {
  const due = activeItems().filter(i => dday(i) <= URGENT_DAYS).sort((a, b) => dday(a) - dday(b));
  due.forEach(item => {
    const key = `${item.id}:${dday(item)}`;
    if (state.notified[key]) return;
    state.notified[key] = Date.now();
    log('notify_shown', { name: item.name, dday: dday(item) });
    pushQueue.push(item.id);
    fireSystemNotification(item);
  });
  save();
  showNextPush();
}

function showNextPush() {
  if (!pushQueue.length) {
    pushEl.hidden = true;
    return;
  }
  const item = itemById(pushQueue[0]);
  if (!item || item.status !== 'active') {
    pushQueue.shift();
    return showNextPush();
  }
  const n = dday(item);
  document.getElementById('pushIcon').textContent = item.emoji;
  document.getElementById('pushText').textContent = n < 0
    ? `${item.name}의 소비기한이 ${Math.abs(n)}일 지났어요. 상태를 확인해 주세요.`
    : `${item.name}의 소비기한이 ${n === 0 ? '오늘까지' : `${n}일 남았`}습니다! 상하기 전에 활용해보세요.`;
  pushEl.hidden = false;
}

function openPush() {
  const id = pushQueue.shift();
  const item = itemById(id);
  if (item) log('notify_open', { name: item.name });
  pushEl.hidden = true;
  if (item) openItemSheet(item.id);
  else showNextPush();
}

document.getElementById('pushOpen').addEventListener('click', openPush);
document.getElementById('push').addEventListener('click', e => {
  /* 모바일에서는 배너 전체가 탭 영역 */
  if (window.innerWidth <= 640 && !e.target.closest('#pushClose')) openPush();
});
document.getElementById('pushClose').addEventListener('click', e => {
  e.stopPropagation();
  pushQueue.shift();
  showNextPush();
});

function fireSystemNotification(item) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('EatSoon 알림', {
      body: `${item.name}의 소비기한이 ${dday(item)}일 남았습니다! 상하기 전에 드세요.`,
      tag: item.id
    });
  } catch { /* 일부 브라우저는 SW 없이는 무시 */ }
}

document.getElementById('btnPermission').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  renderHome();
});

/* 사용자 테스트용: 임박 알림 강제 재발송 */
document.getElementById('btnSimPush').addEventListener('click', () => {
  const urgent = urgentItems();
  if (!urgent.length) {
    toast('임박한 식재료가 없어요. 소비기한이 2일 이내인 재료를 등록해 보세요.');
    return;
  }
  const item = urgent[0];
  log('notify_shown', { name: item.name, dday: dday(item), simulated: true });
  save();
  fireSystemNotification(item);
  pushQueue.unshift(item.id);
  showNextPush();
});

/* ============================================================
   KPI  (10. KPI FRAMEWORK)
   ============================================================ */
function countEvents(type) {
  return state.events.filter(e => e.type === type).length;
}
function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 100) : null;
}

function computeKPI() {
  const eaten = state.items.filter(i => i.status === 'eaten').length;
  const discarded = state.items.filter(i => i.status === 'discarded').length;
  const expiredActive = activeItems().filter(i => dday(i) <= 0).length;
  const reached = eaten + discarded + expiredActive;   // D-Day에 도달한 전체 임박 식재료

  return {
    consume: { value: pct(eaten, reached), num: eaten, den: reached,
      label: '임박 식재료 소비율', target: KPI_TARGET.consume,
      desc: '[먹었어요] 클릭 수 ÷ D-Day 도달 임박 식재료 수' },
    open: { value: pct(countEvents('notify_open'), countEvents('notify_shown')),
      num: countEvents('notify_open'), den: countEvents('notify_shown'),
      label: '알림 확인율 (Open Rate)', target: KPI_TARGET.open,
      desc: 'D-2 푸시를 받고 상세로 진입한 비율' },
    recipe: { value: pct(countEvents('recipe_detail_open'), countEvents('recipe_list_view')),
      num: countEvents('recipe_detail_open'), den: countEvents('recipe_list_view'),
      label: '레시피 열람/선택률', target: KPI_TARGET.recipe,
      desc: '추천 목록 중 하나를 클릭해 조리법을 확인한 비율' },
    funnel: { value: pct(countEvents('register_complete'), countEvents('register_start')),
      num: countEvents('register_complete'), den: countEvents('register_start'),
      label: '등록 완료율 (Funnel)', target: KPI_TARGET.funnel,
      desc: '등록 화면 진입 후 이탈 없이 저장한 비율' }
  };
}

const EVENT_LABEL = {
  register_start: '등록 화면 진입',
  register_complete: '등록 완료',
  notify_shown: '알림 발송',
  notify_open: '알림 확인',
  recipe_list_view: '레시피 목록 조회',
  recipe_detail_open: '레시피 상세 열람',
  consume_eaten: '먹었어요',
  consume_partial: '일부 먹었어요',
  consume_discarded: '버렸어요',
  custom_recipe_add: '내 레시피 추가',
  custom_recipe_edit: '내 레시피 수정',
  custom_recipe_delete: '내 레시피 삭제',
  ai_recipe_generated: 'AI 레시피 생성',
  photo_scan_result: '사진으로 등록 시도'
};

function renderStats() {
  const kpi = computeKPI();
  const main = kpi.consume;

  document.getElementById('kpiMainValue').textContent = main.value === null ? '–' : `${main.value}%`;
  document.getElementById('kpiMainDesc').textContent =
    `목표 ≥ ${main.target}% · 먹었어요 ${main.num}건 ÷ D-Day 도달 ${main.den}건`;

  const verdict = document.getElementById('kpiVerdict');
  if (main.value === null) {
    verdict.textContent = '데이터 수집 중 — 아직 D-Day에 도달한 식재료가 없습니다';
    verdict.className = 'verdict';
  } else if (main.value >= main.target) {
    verdict.textContent = '✅ 가설 충족 (Hypothesis Validated)';
    verdict.className = 'verdict verdict--pass';
  } else {
    verdict.textContent = '⚠️ 가설 미달 — Drop-off 원인 분석 필요';
    verdict.className = 'verdict';
  }

  const grid = document.getElementById('kpiGrid');
  grid.replaceChildren(...['open', 'recipe', 'funnel'].map(key => kpiCard(kpi[key])));

  const logList = document.getElementById('eventLog');
  const rows = state.events.slice(-30).reverse().map(ev => {
    const li = document.createElement('li');
    li.className = 'log__row';
    const meta = ev.meta ? Object.entries(ev.meta).map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
    li.innerHTML = `
      <span class="log__time">${formatTime(ev.at)}</span>
      <span class="log__type"></span>
      <span class="log__meta"></span>`;
    li.querySelector('.log__type').textContent = EVENT_LABEL[ev.type] || ev.type;
    li.querySelector('.log__meta').textContent = meta;
    return li;
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'log__row';
    li.textContent = '아직 수집된 이벤트가 없습니다.';
    rows.push(li);
  }
  logList.replaceChildren(...rows);
}

function kpiCard(k) {
  const card = document.createElement('article');
  card.className = 'kpi-card';
  const value = k.value === null ? '–' : `${k.value}%`;
  const hit = k.value !== null && k.value >= k.target;
  card.innerHTML = `
    <p class="kpi-card__label"></p>
    <p class="kpi-card__value">${value}</p>
    <p class="kpi-card__target">목표 ≥ ${k.target}% · ${k.num}/${k.den}</p>
    <div class="bar"><div class="bar__fill${hit ? '' : ' bar__fill--miss'}" style="width:${Math.min(k.value || 0, 100)}%"></div></div>
    <p class="kpi-card__desc"></p>`;
  card.querySelector('.kpi-card__label').textContent = k.label;
  card.querySelector('.kpi-card__desc').textContent = k.desc;
  return card;
}

/* ============================================================
   DEMO DATA · RESET · TOAST
   ============================================================ */
document.getElementById('btnDemo').addEventListener('click', () => {
  const demo = [
    ['우유', 1], ['두부', 2], ['대파', 4], ['계란', 9], ['김치', 20], ['애호박', 0]
  ];
  demo.forEach(([name, days]) => {
    state.items.push({
      id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name, emoji: emojiFor(name),
      expiry: toISO(new Date(Date.now() + days * DAY)),
      createdAt: Date.now(), status: 'active'
    });
  });
  save();
  renderHome();
  checkNotifications();
  toast('데모 식재료 6개를 넣었어요.');
});

document.getElementById('navReset').addEventListener('click', () => {
  if (!confirm('등록한 식재료, 내 레시피, 수집된 검증 데이터를 모두 삭제할까요? 되돌릴 수 없습니다.')) return;
  state = emptyState();
  pushQueue = [];
  pushEl.hidden = true;
  recipeFilter = null;
  localStorage.removeItem(STORE_KEY);
  renderRoute();
  toast('초기화되었습니다.');
});

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  document.getElementById('toastText').textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ============================================================
   BOOT
   ============================================================ */
if (!location.hash) location.hash = '#/overview';
renderRoute();
checkNotifications();
