// ============================================================================
// Traducteur CDB — Logique applicative
// ----------------------------------------------------------------------------
// Éditeur de fichiers .cdb (SQLite) pour jeux Yu-Gi-Oh!
//   • Chargement des fichiers par l'utilisateur (aucun upload serveur)
//   • Édition des traductions (nom + description)
//   • Écriture directe dans le .cdb via File System Access API
//   • Filtres : cartes taguées, incomplètes, mots-clés personnalisés
//   • Badges auto [XXX] détectés dans les descriptions
// ----------------------------------------------------------------------------
// Dépendances : sql.js 1.10.3 (CDN)
// Navigateurs : Chrome, Edge, Opera
// ============================================================================

// ============================================================================
// ÉTAT
// ============================================================================
let CARDS = [];
let currentIndex = 0;
let dirty = false;
let frDb = null;
let sourceFileHandle = null;
let tradFileHandle = null;
let tradFileName = '';
let supportsFS = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
let customKeywords = [];
const CUSTOM_KEYWORDS_LS = 'cdb-translator-keywords';

const IMAGE_FETCH_TIMEOUT_MS = 8000;
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================================
// SOURCES DE DONNÉES (repo ygo_outil_fr)
// ============================================================================
// Toutes les données (cardinfo + JSON d'images) sont dans data/ du repo
// ygo_outil_fr. Une seule copie à maintenir, partagée avec le Vérif.
const DATA_BASE = 'https://kevinraphael95.github.io/ygo_outil_fr/data/';
const CARDINFO_URL = DATA_BASE + 'cardinfo_fr.txt';
const CARDS_DB_JSON = DATA_BASE + 'cards-db.json';
const YUGI_DB_JSON = DATA_BASE + 'yugipedia-db.json';

(function restoreCustomKeywords() {
  try {
    const s = localStorage.getItem(CUSTOM_KEYWORDS_LS);
    if (s) customKeywords = JSON.parse(s);
    if (!Array.isArray(customKeywords)) customKeywords = [];
  } catch { customKeywords = []; }
})();
function saveCustomKeywords() {
  try { localStorage.setItem(CUSTOM_KEYWORDS_LS, JSON.stringify(customKeywords)); } catch {}
}

// ============================================================================
// CODES YGOPRO (chargés depuis cardinfo_fr.txt)
// ============================================================================
let ATTRIBUTES = {};
let TYPES = [];
let RACES = {};

async function loadCardInfo(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cardinfo introuvable : ${url} (HTTP ${res.status})`);
  const text = await res.text();
  const lines = text.split(/\r?\n/);
  let section = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line) continue;
    if (line.startsWith('##')) { section = line.slice(2).trim().toLowerCase(); continue; }
    if (line.startsWith('#end')) break;
    if (line.startsWith('#')) continue;

    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) continue;

    const hexPart = line.slice(0, tabIdx).trim();
    const label = line.slice(tabIdx + 1).trim();

    let value;
    if (hexPart.startsWith('-')) value = parseInt(hexPart, 10);
    else value = parseInt(hexPart, 16);
    if (isNaN(value)) continue;

    if (section === 'attribute') ATTRIBUTES[value] = label;
    else if (section === 'type') TYPES.push({ v: value, label });
    else if (section === 'race') RACES[value] = label;
  }

  console.log(`✅ cardinfo chargé : ${Object.keys(ATTRIBUTES).length} attributs, ${TYPES.length} types, ${Object.keys(RACES).length} races`);
}

function attributeToString(a) { return a ? (ATTRIBUTES[a] || `Attr${a}`) : '—'; }

function typeToString(t) {
  if (!t) return '—';
  const p = [];
  for (const x of TYPES) if (t & x.v) p.push(x.label);
  return p.length ? p.join(' / ') : `Type ${t}`;
}

function formatStat(v) {
  if (v == null) return '—';
  if (v === -2 || v === -1) return '?';
  if (v < 0) return '0';
  return String(v);
}

function normalizeNewlines(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ============================================================================
// TAGS AUTO
// ============================================================================
function extractTags(descFr) {
  if (!descFr) return [];
  const matches = descFr.match(/\[([A-Z0-9_-]+)\]/gi);
  if (!matches) return [];
  const seen = new Set();
  const tags = [];
  for (const m of matches) {
    const tag = m.slice(1, -1).toUpperCase();
    if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
  }
  return tags;
}

function tagHue(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}

function renderTags(descFr) {
  const container = document.getElementById('transTags');
  if (!container) return;
  const tags = extractTags(descFr);
  if (!tags.length) { container.innerHTML = ''; return; }
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  container.innerHTML = tags.map(tag => {
    const h = tagHue(tag);
    const bg = isDark ? `hsla(${h}, 60%, 40%, 0.18)` : `hsl(${h}, 70%, 92%)`;
    const fg = isDark ? `hsl(${h}, 70%, 70%)` : `hsl(${h}, 65%, 32%)`;
    return `<span class="tag-badge" style="background:${bg};color:${fg}">[${esc(tag)}]</span>`;
  }).join('');
}

// ============================================================================
// FILTRES
// ============================================================================
function isTaggedCard(card) { return extractTags(card.desc_fr).length > 0; }
function isIncompleteCard(card) { return card.missingFr === true || card.missingEn === true; }

function getFilterState() {
  return {
    vaact: !!document.getElementById('filterVaact')?.checked,
    incomplete: !!document.getElementById('filterIncomplete')?.checked,
    keywords: customKeywords,
  };
}
function countActiveFilters() {
  const { vaact, incomplete, keywords } = getFilterState();
  return (vaact ? 1 : 0) + (incomplete ? 1 : 0) + keywords.length;
}
function getFilteredCards() {
  let list = CARDS;
  const { vaact, incomplete, keywords } = getFilterState();
  if (vaact) list = list.filter(isTaggedCard);
  if (incomplete) list = list.filter(isIncompleteCard);
  if (keywords.length) {
    list = list.filter(c => {
      const h = [
        (c.name_en || '').toLowerCase(),
        (c.name_fr || '').toLowerCase(),
        (c.id || ''),
      ].join(' ');
      return keywords.every(kw => h.includes(kw));
    });
  }
  return list;
}
function updateFiltersBadge() {
  const btn = document.getElementById('filtersBtn');
  if (!btn) return;
  const count = countActiveFilters();
  btn.classList.toggle('active', count > 0);
  const badge = btn.querySelector('.badge-count');
  if (badge) {
    if (count > 0) { badge.textContent = String(count); badge.style.display = 'inline-flex'; }
    else badge.style.display = 'none';
  }
}

// ============================================================================
// IMAGES — index préconstruit depuis data/*.json
// ============================================================================
const imageCache = {};
let imageIndexById = null;
let imageIndexByName = null;
let localCardsDb = null;
let localYugiDb = null;

// Délai avant de lancer le chargement d'une image : si on change de carte
// avant la fin du délai, la demande est annulée (évite les 429 de Yugipedia
// quand on enchaîne Suivant / Aléatoire).
const IMAGE_LOAD_DELAY_MS = 150;
let imageTimer = null;

const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function buildImageIndex() {
  imageIndexById = new Map();
  imageIndexByName = new Map();

  if (localCardsDb) {
    for (const [id, c] of Object.entries(localCardsDb)) {
      const img = c?.img_cropped || c?.img_full;
      if (!img) continue;
      imageIndexById.set(String(id).trim(), img);
      for (const n of [c.en, c.fr]) {
        const k = normName(n);
        if (k && !imageIndexByName.has(k)) imageIndexByName.set(k, img);
      }
    }
  }
  if (localYugiDb) {
    for (const [key, y] of Object.entries(localYugiDb)) {
      const img = y?.img || y?.img_en;
      if (!img) continue;
      if (!imageIndexById.has(String(key).trim())) {
        imageIndexById.set(String(key).trim(), img);
      }
      for (const n of [key, y.en, y.fr]) {
        const k = normName(n);
        if (k && !imageIndexByName.has(k)) imageIndexByName.set(k, img);
      }
    }
  }
  console.log(`✅ Index images : ${imageIndexById.size} par ID, ${imageIndexByName.size} par nom`);
}

async function loadLocalDatabases() {
  try {
    const [a, b] = await Promise.allSettled([
      fetch(CARDS_DB_JSON).then(r => r.ok ? r.json() : null),
      fetch(YUGI_DB_JSON).then(r => r.ok ? r.json() : null),
    ]);
    if (a.status === 'fulfilled' && a.value) localCardsDb = a.value;
    if (b.status === 'fulfilled' && b.value) localYugiDb = b.value;
  } catch (e) {
    console.warn('Erreur chargement DB locales:', e);
  }
}

function findImageUrl(card) {
  if (!card) return null;
  const id = String(card.id || '').trim();
  if (id && imageIndexById?.has(id)) return imageIndexById.get(id);
  const nEn = normName(card.name_en);
  if (nEn && imageIndexByName?.has(nEn)) return imageIndexByName.get(nEn);
  const nFr = normName(card.name_fr);
  if (nFr && imageIndexByName?.has(nFr)) return imageIndexByName.get(nFr);
  return null;
}

async function fetchCardImage(card) {
  if (!card) return null;
  const key = String(card.id || card.name_en || card.name_fr || '').trim();
  if (imageCache[key] !== undefined) return imageCache[key];
  const url = findImageUrl(card);
  imageCache[key] = url || null;
  return imageCache[key];
}

function ensurePlaceholder(parent) {
  let ph = parent.querySelector('.img-placeholder');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'img-placeholder';
    ph.textContent = '🃏';
    parent.style.position = 'relative';
    parent.appendChild(ph);
  }
  return ph;
}

async function loadCardImage(card) {
  const imgEl = document.getElementById('cardImg');
  if (!imgEl) return;

  // Annule la demande précédente si elle n'est pas encore partie
  clearTimeout(imageTimer);

  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';
  imgEl.alt = card?.name_fr || card?.name_en || 'Carte';

  const parent = imgEl.parentElement;
  ensurePlaceholder(parent);

  imageTimer = setTimeout(async () => {
    const url = await fetchCardImage(card);
    if (getFilteredCards()[currentIndex] !== card) return;
    if (!url) return;

    imgEl.onload = () => {
      const ph = parent.querySelector('.img-placeholder');
      if (ph) ph.remove();
      imgEl.style.display = 'block';
    };
    imgEl.onerror = () => {
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
    };
    imgEl.src = url;
  }, IMAGE_LOAD_DELAY_MS);
}

// ============================================================================
// SÉLECTION DES FICHIERS
// ============================================================================
async function pickCdb(type) {
  if (!supportsFS) {
    setGlobalStatus('Navigateur non supporté. Utilise Chrome, Edge ou Opera.', false);
    return;
  }
  try {
    const [h] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'CDB SQLite', accept: { 'application/x-sqlite3': ['.cdb'] } }]
    });
    try {
      const file = await h.getFile();
      const header = new TextDecoder().decode((await file.slice(0, 16).arrayBuffer()));
      if (!header.startsWith('SQLite format 3')) {
        setGlobalStatus('Ce fichier n\'est pas un .cdb valide.', false);
        return;
      }
    } catch (e) {}
    if (type === 'source') {
      sourceFileHandle = h;
      document.getElementById('cardSource').classList.add('picked');
      document.getElementById('subSource').textContent = h.name;
    } else {
      tradFileHandle = h;
      tradFileName = h.name;
      document.getElementById('cardTrad').classList.add('picked');
      document.getElementById('subTrad').textContent = h.name;
    }
    document.getElementById('startBtn').disabled = !sourceFileHandle;
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
}

// ============================================================================
// CRÉATION D'UNE BASE FR VIDE
// ============================================================================
function createEmptyFrDb(SQL) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE texts (
    id integer primary key,
    name text, desc text,
    str1 text, str2 text, str3 text, str4 text,
    str5 text, str6 text, str7 text, str8 text,
    str9 text, str10 text, str11 text, str12 text,
    str13 text, str14 text, str15 text, str16 text
  )`);
  db.run(`CREATE TABLE datas (
    id integer primary key,
    ot integer, alias integer, setcode integer,
    type integer, atk integer, def integer, level integer,
    race integer, attribute integer, category integer
  )`);
  return db;
}

// ============================================================================
// DÉMARRAGE
// ============================================================================
async function startApp() {
  if (!sourceFileHandle) {
    setGlobalStatus('Il faut sélectionner un deck à traduire pour commencer.', false);
    return;
  }

  const lt = document.getElementById('loadingText');
  document.getElementById('loadingScreen').style.display = 'flex';
  document.getElementById('welcomeScreen').style.display = 'none';

  try {
    lt.textContent = 'Chargement du cardinfo…';
    await loadCardInfo(CARDINFO_URL);

    lt.textContent = 'Chargement des images…';
    await loadLocalDatabases();
    buildImageIndex();

    lt.textContent = 'Initialisation de SQLite…';
    const SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` });
    window.SQL = SQL;

    lt.textContent = 'Lecture du deck à traduire…';
    const sourceFile = await sourceFileHandle.getFile();
    const sourceBuf = await sourceFile.arrayBuffer();
    const sourceDb = new SQL.Database(new Uint8Array(sourceBuf));

    if (tradFileHandle) {
      lt.textContent = 'Lecture de la traduction existante…';
      const tradFile = await tradFileHandle.getFile();
      const tradBuf = await tradFile.arrayBuffer();
      frDb = new SQL.Database(new Uint8Array(tradBuf));
    } else {
      lt.textContent = 'Création d\'une nouvelle traduction…';
      frDb = createEmptyFrDb(SQL);
      tradFileName = '';
    }

    lt.textContent = 'Fusion…';
    const sourceCards = extractCards(sourceDb);
    const tradCards = extractCards(frDb);
    CARDS = mergeCards(sourceCards, tradCards);
    sourceDb.close();

    console.log(`✅ ${CARDS.length} cartes chargées`);

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    document.body.classList.add('has-nav');
    updateTopbarHeight();

    renderCustomChips();
    updateFiltersBadge();
    render();

  } catch (err) {
    console.error('❌', err);
    setGlobalStatus('Erreur de chargement : ' + err.message, false);
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('welcomeScreen').style.display = 'flex';
  }
}

// ============================================================================
// EXTRACTION
// ============================================================================
function extractCards(db) {
  const t = db.exec("SELECT id, name, desc FROM texts")[0];
  if (!t) return {};
  let d;
  try { d = db.exec("SELECT id, type, atk, def, level, race, attribute FROM datas")[0]; }
  catch { d = null; }
  const dById = {};
  if (d) for (const row of d.values) dById[String(row[0])] = {
    type: row[1], atk: row[2], def: row[3], level: row[4], race: row[5], attribute: row[6]
  };
  const out = {};
  for (const [id, name, desc] of t.values) {
    const k = String(id);
    out[k] = { id: k, name: name || '', desc: desc || '', ...(dById[k] || {}) };
  }
  return out;
}

// ============================================================================
// FUSION
// ============================================================================
function mergeCards(sourceCards, tradCards) {
  const result = [];
  for (const id in sourceCards) {
    const en = sourceCards[id];
    const fr = tradCards[id];
    if (!fr) {
      result.push({
        id: en.id,
        name_en: en.name, desc_en: en.desc,
        name_fr: '', desc_fr: '',
        name_fr_orig: '', desc_fr_orig: '',
        type: en.type || '',
        atk: en.atk ?? null, def: en.def ?? null, level: en.level ?? null,
        attribute: en.attribute || '',
        edited: false,
        missingFr: true,
      });
      continue;
    }
    const name_fr = normalizeNewlines(fr.name);
    const desc_fr = normalizeNewlines(fr.desc);
    result.push({
      id: en.id,
      name_en: en.name, desc_en: en.desc,
      name_fr, desc_fr,
      name_fr_orig: name_fr, desc_fr_orig: desc_fr,
      type: en.type || fr.type || '',
      atk: en.atk ?? null, def: en.def ?? null, level: en.level ?? null,
      attribute: en.attribute || fr.attribute || '',
      edited: false,
    });
  }
  for (const id in tradCards) {
    if (sourceCards[id]) continue;
    const fr = tradCards[id];
    const name_fr = normalizeNewlines(fr.name);
    const desc_fr = normalizeNewlines(fr.desc);
    result.push({
      id: fr.id,
      name_en: '', desc_en: '',
      name_fr, desc_fr,
      name_fr_orig: name_fr, desc_fr_orig: desc_fr,
      type: fr.type || '',
      atk: fr.atk ?? null, def: fr.def ?? null, level: fr.level ?? null,
      attribute: fr.attribute || '',
      edited: false,
      missingEn: true,
    });
  }
  result.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  return result;
}

// ============================================================================
// RENDER
// ============================================================================
function render() {
  if (!CARDS.length) return;
  const filtered = getFilteredCards();

  if (!filtered.length) {
    ['infoId','infoType','infoAttr','infoStats','infoLevel'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '—';
    });
    document.getElementById('infoStatus').textContent = 'Aucune carte';
    document.getElementById('origName').textContent = '—';
    document.getElementById('origDesc').textContent = 'Aucune carte ne correspond aux filtres actifs.';
    clearTimeout(imageTimer);
    const imgEl = document.getElementById('cardImg');
    if (imgEl) {
      imgEl.onload = null; imgEl.onerror = null;
      imgEl.removeAttribute('src'); imgEl.style.display = 'none';
      ensurePlaceholder(imgEl.parentElement);
    }
    const nameEl = document.getElementById('editNameFr');
    const descEl = document.getElementById('editDescFr');
    if (nameEl) { nameEl.value = ''; nameEl.disabled = true; }
    if (descEl) { descEl.value = ''; descEl.disabled = true; }
    const tagsEl = document.getElementById('transTags');
    if (tagsEl) tagsEl.innerHTML = '';
    const mb = document.getElementById('missingBadge');
    if (mb) mb.style.display = 'none';
    const modb = document.getElementById('modifiedBadge');
    if (modb) modb.style.display = 'none';
    document.getElementById('navCenter').textContent = '0 / 0';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    return;
  }

  const nameEl = document.getElementById('editNameFr');
  const descEl = document.getElementById('editDescFr');
  if (nameEl) nameEl.disabled = false;
  if (descEl) descEl.disabled = false;

  if (currentIndex >= filtered.length) currentIndex = 0;
  const card = filtered[currentIndex];

  loadCardImage(card);

  document.getElementById('infoId').textContent = card.id || '—';
  document.getElementById('infoType').textContent = typeToString(card.type);
  document.getElementById('infoAttr').textContent = attributeToString(card.attribute);
  document.getElementById('infoStats').textContent = formatStat(card.atk) + ' / ' + formatStat(card.def);
  document.getElementById('infoLevel').textContent = card.level ?? '—';
  document.getElementById('infoStatus').textContent =
    card.missingFr ? '⚠️ À traduire' :
    card.missingEn ? '⚠️ Orpheline' :
    card.edited ? '✏️ Modifiée' : '✔️ Traduite';

  document.getElementById('origName').textContent = card.name_en || '—';
  document.getElementById('origDesc').textContent = card.desc_en || '—';
  document.getElementById('editNameFr').value = card.name_fr || '';
  document.getElementById('editDescFr').value = card.desc_fr || '';

  renderTags(card.desc_fr);
  document.getElementById('modifiedBadge').style.display = card.edited ? '' : 'none';

  const mb = document.getElementById('missingBadge');
  if (mb) {
    if (card.missingFr) { mb.textContent = '⚠️ Traduction manquante'; mb.style.display = ''; }
    else if (card.missingEn) { mb.textContent = '⚠️ Original manquant'; mb.style.display = ''; }
    else mb.style.display = 'none';
  }

  document.getElementById('navCenter').textContent = `${currentIndex + 1} / ${filtered.length}`;
  document.getElementById('prevBtn').disabled = currentIndex === 0;
  document.getElementById('nextBtn').disabled = currentIndex === filtered.length - 1;

  setSaveStatus('');
  updateModifiedCount();
}

function setSaveStatus(msg, ok = true) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !ok && !!msg);
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
}
function setGlobalStatus(msg, ok = true) {
  const el = document.getElementById('globalStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !ok && !!msg);
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500);
}
function updateModifiedCount() {
  const wrap = document.getElementById('modifiedCount');
  const val = document.getElementById('modifiedCountValue');
  if (!wrap || !val) return;
  const n = CARDS.filter(c => c.edited).length;
  val.textContent = String(n);
  wrap.style.display = n > 0 ? '' : 'none';
}
function hasUnsavedChanges() {
  const nameEl = document.getElementById('editNameFr');
  const descEl = document.getElementById('editDescFr');
  if (!nameEl || !descEl) return false;
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return false;
  return nameEl.value !== (card.name_fr || '')
      || normalizeNewlines(descEl.value) !== normalizeNewlines(card.desc_fr);
}
function confirmDiscardIfDirty() {
  if (!dirty) return true;
  return confirm('Modifications non enregistrées sur cette carte. Continuer et les perdre ?');
}

// ============================================================================
// ÉCRITURE DANS LE .CDB
// ============================================================================
async function ensureFileHandle() {
  if (tradFileHandle) {
    const perm = await tradFileHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    const req = await tradFileHandle.requestPermission({ mode: 'readwrite' });
    return req === 'granted';
  }
  try {
    const h = await window.showSaveFilePicker({
      suggestedName: 'VAACT_S1_fr.cdb',
      types: [{ description: 'CDB SQLite', accept: { 'application/x-sqlite3': ['.cdb'] } }]
    });
    tradFileHandle = h;
    tradFileName = h.name;
    document.getElementById('subTrad').textContent = h.name;
    document.getElementById('cardTrad').classList.add('picked');
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    console.error(e);
    setGlobalStatus('Erreur création fichier : ' + e.message, false);
    return false;
  }
}
async function writeCdbToDisk() {
  if (!frDb || !tradFileHandle) return;
  const data = frDb.export();
  const w = await tradFileHandle.createWritable();
  await w.write(data);
  await w.close();
}
function updateDbForCard(card, name_fr, desc_fr) {
  if (!frDb) return;
  const idNum = parseInt(card.id, 10);
  if (!Number.isFinite(idNum)) return;
  const cols = ['id', 'name', 'desc'];
  const vals = [idNum, name_fr, desc_fr];
  for (let i = 1; i <= 16; i++) { cols.push('str' + i); vals.push(''); }
  const placeholders = cols.map(() => '?').join(',');
  const sql = `INSERT OR REPLACE INTO texts (${cols.join(',')}) VALUES (${placeholders})`;
  frDb.run(sql, vals);
}
function deleteDbCard(card) {
  if (!frDb) return;
  const idNum = parseInt(card.id, 10);
  if (!Number.isFinite(idNum)) return;
  frDb.run("DELETE FROM texts WHERE id = ?", [idNum]);
}

// ============================================================================
// ÉDITION
// ============================================================================
async function saveCurrentCard() {
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return;
  if (!supportsFS) { setSaveStatus('❌ Navigateur non compatible', false); return; }

  const name_fr = document.getElementById('editNameFr').value;
  const desc_fr = document.getElementById('editDescFr').value;

  let ok;
  try { ok = await ensureFileHandle(); }
  catch (e) { setSaveStatus('❌ Erreur accès fichier : ' + e.message, false); return; }
  if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

  updateDbForCard(card, name_fr, desc_fr);
  card.name_fr = name_fr;
  card.desc_fr = desc_fr;

  if (card.missingFr) {
    if (name_fr.trim() || desc_fr.trim()) card.missingFr = false;
    card.edited = (name_fr.trim() !== '') || (desc_fr.trim() !== '');
  } else {
    card.edited = (name_fr !== card.name_fr_orig)
               || (normalizeNewlines(desc_fr) !== normalizeNewlines(card.desc_fr_orig));
  }

  try {
    await writeCdbToDisk();
    setSaveStatus(`💾 Enregistré dans ${tradFileName || 'nouveau fichier'}`, true);
  } catch (e) { setSaveStatus('❌ Erreur écriture : ' + e.message, false); return; }

  renderTags(card.desc_fr);
  document.getElementById('modifiedBadge').style.display = card.edited ? '' : 'none';
  const mb = document.getElementById('missingBadge');
  if (mb) {
    if (card.missingFr) { mb.textContent = '⚠️ Traduction manquante'; mb.style.display = ''; }
    else if (card.missingEn) { mb.textContent = '⚠️ Original manquant'; mb.style.display = ''; }
    else mb.style.display = 'none';
  }
  document.getElementById('infoStatus').textContent =
    card.missingFr ? '⚠️ À traduire' :
    card.missingEn ? '⚠️ Orpheline' :
    card.edited ? '✏️ Modifiée' : '✔️ Traduite';

  dirty = false;
  updateModifiedCount();
}

async function resetCurrentCard() {
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return;

  if (card.missingFr) {
    if ((card.name_fr || card.desc_fr) && !confirm('Vider cette traduction ?')) return;
    let ok;
    try { ok = await ensureFileHandle(); }
    catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); return; }
    if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }
    card.name_fr = ''; card.desc_fr = ''; card.edited = false;
    deleteDbCard(card);
    try { await writeCdbToDisk(); setSaveStatus('↺ Traduction supprimée', true); }
    catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); }
    render();
    return;
  }

  if (card.edited && !confirm('Réinitialiser cette carte à sa traduction d\'origine ?')) return;
  let ok;
  try { ok = await ensureFileHandle(); }
  catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); return; }
  if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

  card.name_fr = card.name_fr_orig;
  card.desc_fr = card.desc_fr_orig;
  card.edited = false;
  updateDbForCard(card, card.name_fr, card.desc_fr);
  try { await writeCdbToDisk(); setSaveStatus('↺ Réinitialisé', true); }
  catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); }
  render();
}

// ============================================================================
// NAVIGATION
// ============================================================================
function goPrev() {
  if (!confirmDiscardIfDirty()) return;
  if (currentIndex > 0) { currentIndex--; render(); }
}
function goNext() {
  if (!confirmDiscardIfDirty()) return;
  const f = getFilteredCards();
  if (currentIndex < f.length - 1) { currentIndex++; render(); }
}
function goRandom() {
  if (!confirmDiscardIfDirty()) return;
  const f = getFilteredCards();
  if (!f.length) return;
  currentIndex = Math.floor(Math.random() * f.length);
  render();
}

document.getElementById('prevBtn').addEventListener('click', goPrev);
document.getElementById('nextBtn').addEventListener('click', goNext);
document.getElementById('randomBtn').addEventListener('click', goRandom);
document.getElementById('saveBtn').addEventListener('click', saveCurrentCard);
document.getElementById('resetCardBtn').addEventListener('click', resetCurrentCard);

// ============================================================================
// PANNEAU FILTRES
// ============================================================================
const filtersBtn = document.getElementById('filtersBtn');
const filtersPanel = document.getElementById('filtersPanel');

function openFiltersPanel() {
  if (!filtersPanel) return;
  filtersPanel.classList.add('open');
  filtersBtn?.setAttribute('aria-expanded', 'true');
}
function closeFiltersPanel(restoreFocus = false) {
  if (!filtersPanel) return;
  const wasOpen = filtersPanel.classList.contains('open');
  filtersPanel.classList.remove('open');
  filtersBtn?.setAttribute('aria-expanded', 'false');
  if (wasOpen && restoreFocus) filtersBtn?.focus();
}

if (filtersBtn && filtersPanel) {
  filtersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (filtersPanel.classList.contains('open')) closeFiltersPanel();
    else openFiltersPanel();
  });
  document.addEventListener('click', (e) => {
    if (!filtersPanel.contains(e.target) && !filtersBtn.contains(e.target)) {
      closeFiltersPanel();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filtersPanel.classList.contains('open')) {
      closeFiltersPanel(true);
    }
  });
}

// ============================================================================
// CHECKBOXES FILTRES
// ============================================================================
['filterVaact', 'filterIncomplete'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    if (!confirmDiscardIfDirty()) {
      el.checked = !el.checked;
      return;
    }
    currentIndex = 0;
    render();
    updateFiltersBadge();
  });
});

// ============================================================================
// FILTRES PERSONNALISÉS
// ============================================================================
const customInput = document.getElementById('customKeywordInput');
const customAddBtn = document.getElementById('customAddBtn');
const customChips = document.getElementById('customChips');
const customResetBtn = document.getElementById('filterResetBtn');

function addCustomKeyword(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return;
  if (customKeywords.includes(v)) return;
  customKeywords.push(v);
  saveCustomKeywords();
  renderCustomChips();
  currentIndex = 0;
  render();
  updateFiltersBadge();
}
function removeCustomKeyword(v) {
  const i = customKeywords.indexOf(v);
  if (i === -1) return;
  customKeywords.splice(i, 1);
  saveCustomKeywords();
  renderCustomChips();
  currentIndex = 0;
  render();
  updateFiltersBadge();
}
function renderCustomChips() {
  if (!customChips) return;
  if (!customKeywords.length) { customChips.innerHTML = ''; return; }
  customChips.innerHTML = customKeywords.map(kw => `
    <span class="custom-chip">
      <span class="chip-label">${esc(kw)}</span>
      <button type="button" class="chip-remove" data-keyword="${esc(kw)}" title="Retirer" aria-label="Retirer le filtre : ${esc(kw)}">✕</button>
    </span>
  `).join('');
  customChips.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCustomKeyword(btn.dataset.keyword);
    });
  });
}
if (customAddBtn && customInput) {
  customAddBtn.addEventListener('click', () => {
    addCustomKeyword(customInput.value);
    customInput.value = '';
    customInput.focus();
  });
  customInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addCustomKeyword(customInput.value);
      customInput.value = '';
    }
  });
}
if (customResetBtn) {
  customResetBtn.addEventListener('click', () => {
    const v = document.getElementById('filterVaact');
    const i = document.getElementById('filterIncomplete');
    if (v) v.checked = false;
    if (i) i.checked = false;
    customKeywords = [];
    saveCustomKeywords();
    renderCustomChips();
    currentIndex = 0;
    render();
    updateFiltersBadge();
  });
}

// ============================================================================
// RECHERCHE
// ============================================================================
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');

function updateSearchIndicator() {
  if (!searchInput) return;
  const wrap = searchInput.closest('.search-wrap') || searchInput.parentElement;
  if (wrap) wrap.classList.toggle('has-search', searchInput.value.trim().length > 0);
}
function jumpToFirstMatch() {
  if (!searchInput) return;
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return;
  if (!confirmDiscardIfDirty()) return;
  const f = getFilteredCards();
  const found = f.findIndex(c =>
    (c.name_en || '').toLowerCase().includes(q) ||
    (c.name_fr || '').toLowerCase().includes(q) ||
    (c.id || '').includes(q)
  );
  if (found >= 0) { currentIndex = found; render(); }
  else setGlobalStatus(`Aucune carte ne correspond à « ${q} »`, false);
}
if (searchInput) {
  searchInput.addEventListener('input', updateSearchIndicator);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jumpToFirstMatch(); searchInput.blur(); }
    else if (e.key === 'Escape') { searchInput.value = ''; updateSearchIndicator(); }
  });
}
searchClear?.addEventListener('click', () => {
  searchInput.value = '';
  updateSearchIndicator();
  searchInput.focus();
});

// ============================================================================
// DIRTY TRACKING
// ============================================================================
function markDirty() {
  const now = hasUnsavedChanges();
  if (now === dirty) return;
  dirty = now;
  if (dirty) setSaveStatus('Non enregistré…', false);
  else setSaveStatus('');
}
document.getElementById('editNameFr').addEventListener('input', markDirty);
document.getElementById('editDescFr').addEventListener('input', markDirty);

// ============================================================================
// RACCOURCIS CLAVIER
// ============================================================================
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCurrentCard();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') goPrev();
  else if (e.key === 'ArrowRight') goNext();
});

// ============================================================================
// WARNING AVANT DE QUITTER
// ============================================================================
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); }
});

// ============================================================================
// UTIL
// ============================================================================
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function updateTopbarHeight() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  document.documentElement.style.setProperty('--topbar-height', topbar.offsetHeight + 'px');
}
window.addEventListener('resize', updateTopbarHeight);

// ============================================================================
// THÈME
// ============================================================================
const THEME_KEY = 'cdb-translator-theme';

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const icon = t === 'dark' ? '☀️' : '🌙';
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = icon;
  const btnW = document.getElementById('themeToggleWelcome');
  if (btnW) btnW.textContent = icon;
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  const card = getFilteredCards()[currentIndex];
  if (card) renderTags(card.desc_fr);
}

document.getElementById('themeToggle').addEventListener('click', toggleTheme);

const themeToggleWelcome = document.getElementById('themeToggleWelcome');
if (themeToggleWelcome) {
  themeToggleWelcome.addEventListener('click', toggleTheme);
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

// ============================================================================
// INIT
// ============================================================================
document.getElementById('pickSourceBtn').addEventListener('click', () => pickCdb('source'));
document.getElementById('pickTradBtn').addEventListener('click', () => pickCdb('trad'));
document.getElementById('startBtn').addEventListener('click', startApp);

if (!supportsFS) {
  const btn = document.getElementById('startBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '❌ Navigateur non compatible';
  }
}
