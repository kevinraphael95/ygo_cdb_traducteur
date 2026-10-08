// ============================================================================
// ÉTAT
// ============================================================================
let CARDS = [];
let currentIndex = 0;
let dirty = false;
let frDb = null;
let sourceFileHandle = null;    // deck à traduire (requis)
let tradFileHandle = null;      // traduction existante (optionnel)
let tradFileName = '';
let supportsFS = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
let customKeywords = [];
const CUSTOM_KEYWORDS_LS = 'vaact-custom-keywords';

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
// CODES YGOPRO
// ============================================================================
const ATTRIBUTES = { 1:'EARTH',2:'WATER',4:'FIRE',8:'WIND',16:'LIGHT',32:'DARK',64:'DIVINE' };
function attributeToString(a) { return a ? (ATTRIBUTES[a] || `Attr${a}`) : '—'; }

const TYPES = [
  { v:1,label:'Monstre' },{ v:2,label:'Magie' },{ v:4,label:'Piège' },
  { v:16,label:'Normal' },{ v:32,label:'Effet' },{ v:64,label:'Fusion' },
  { v:128,label:'Rituel' },{ v:256,label:'Spirit' },{ v:512,label:'Union' },
  { v:1024,label:'Gemini' },{ v:2048,label:'Tuner' },{ v:4096,label:'Synchro' },
  { v:16384,label:'Quick-Play' },{ v:65536,label:'Continu' },
  { v:131072,label:'Équipement' },{ v:262144,label:'Terrain' },
  { v:524288,label:'Compteur' },{ v:1048576,label:'Flip' },
  { v:2097152,label:'Toon' },{ v:4194304,label:'Xyz' },
  { v:8388608,label:'Pendule' },{ v:16777216,label:'Lien' },
];
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
// FILTRES
// ============================================================================
function isVaactCard(card) { return (card.desc_fr || '').trim().startsWith('(VAACT'); }
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
  if (vaact) list = list.filter(isVaactCard);
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
// IMAGES
// ============================================================================
const imageCache = {};
async function fetchCardImage(name) {
  if (!name) return null;
  if (imageCache[name] !== undefined) return imageCache[name];
  const k = 'img_' + name;
  try { const c = localStorage.getItem(k); if (c) { imageCache[name] = c; return c; } } catch {}
  try {
    const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
    const r = await fetch(url);
    if (!r.ok) { imageCache[name] = null; return null; }
    const d = await r.json();
    const u = d.data?.[0]?.card_images?.[0]?.image_url_cropped
           || d.data?.[0]?.card_images?.[0]?.image_url || null;
    imageCache[name] = u;
    if (u) try { localStorage.setItem(k, u); } catch {}
    return u;
  } catch { imageCache[name] = null; return null; }
}
async function loadCardImage(card) {
  const imgEl = document.getElementById('cardImg');
  if (!imgEl) return;
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';
  const p = imgEl.parentElement;
  let ph = p.querySelector('.img-placeholder');
  if (!ph) {
    ph = document.createElement('div');
    ph.className = 'img-placeholder';
    ph.textContent = '🃏';
    ph.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:48px;color:#555;';
    p.style.position = 'relative';
    p.appendChild(ph);
  }
  const url = await fetchCardImage(card.name_en) || await fetchCardImage(card.name_fr);
  if (getFilteredCards()[currentIndex] !== card) return;
  if (!url) return;
  ph?.remove();
  imgEl.src = url;
  imgEl.style.display = 'block';
}

// ============================================================================
// SÉLECTION DES FICHIERS PAR L'UTILISATEUR
// ============================================================================
async function pickCdb(type) {
  // type = 'source' ou 'trad'
  if (!supportsFS) {
    alert('Ton navigateur ne supporte pas la sélection de fichiers. Utilise Chrome, Edge ou Opera.');
    return;
  }
  try {
    const [h] = await window.showOpenFilePicker({
      multiple: false,
      types: [{ description: 'CDB SQLite', accept: { 'application/x-sqlite3': ['.cdb'] } }]
    });

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
// DÉMARRAGE DE L'APP
// ============================================================================
async function startApp() {
  if (!sourceFileHandle) {
    alert('Il faut sélectionner un deck à traduire pour commencer.');
    return;
  }

  const lt = document.getElementById('loadingText');
  document.getElementById('loadingScreen').style.display = 'flex';
  document.getElementById('welcomeScreen').style.display = 'none';

  try {
    lt.textContent = 'Initialisation de SQLite…';
    const SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}` });
    window.SQL = SQL;

    // Charger le deck à traduire
    lt.textContent = 'Lecture du deck à traduire…';
    const sourceFile = await sourceFileHandle.getFile();
    const sourceBuf = await sourceFile.arrayBuffer();
    const sourceDb = new SQL.Database(new Uint8Array(sourceBuf));

    // Charger la traduction si fournie, sinon créer une base vide
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

    const missingFr = CARDS.filter(c => c.missingFr).length;
    const missingEn = CARDS.filter(c => c.missingEn).length;
    console.log(`✅ ${CARDS.length} cartes chargées`);
    console.log(`   • ${missingFr} sans traduction`);
    console.log(`   • ${missingEn} sans original`);

    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';

    renderCustomChips();
    updateFiltersBadge();
    render();

  } catch (err) {
    console.error('❌', err);
    alert('Erreur de chargement : ' + err.message);
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
// FUSION — avec détection des orphelines
// ============================================================================
function mergeCards(sourceCards, tradCards) {
  const result = [];
  const sourceOnly = [];
  const tradOnly = [];

  for (const id in sourceCards) {
    const en = sourceCards[id];
    const fr = tradCards[id];

    if (!fr) {
      sourceOnly.push({ id, name: en.name });
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
    tradOnly.push({ id, name: fr.name });

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

  if (sourceOnly.length) {
    console.warn(`⚠️ ${sourceOnly.length} carte(s) sans traduction :`);
    console.table(sourceOnly.slice(0, 20));
  }
  if (tradOnly.length) {
    console.warn(`⚠️ ${tradOnly.length} carte(s) traduites sans original :`);
    console.table(tradOnly.slice(0, 20));
  }
  if (!sourceOnly.length && !tradOnly.length && Object.keys(sourceCards).length && Object.keys(tradCards).length) {
    console.log('✅ Aucune carte orpheline — les deux fichiers sont synchronisés.');
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
    document.getElementById('translationSection').innerHTML =
      `<div class="no-comments">Aucune carte ne correspond aux filtres actifs.</div>`;
    document.getElementById('navCenter').textContent = '0 / 0';
    document.getElementById('prevBtn').disabled = true;
    document.getElementById('nextBtn').disabled = true;
    return;
  }
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

  document.getElementById('vaactBadge').style.display = isVaactCard(card) ? '' : 'none';
  document.getElementById('modifiedBadge').style.display = card.edited ? '' : 'none';

  const mb = document.getElementById('missingBadge');
  if (mb) {
    if (card.missingFr) {
      mb.textContent = '⚠️ Traduction manquante';
      mb.style.display = '';
    } else if (card.missingEn) {
      mb.textContent = '⚠️ Original manquant';
      mb.style.display = '';
    } else {
      mb.style.display = 'none';
    }
  }

  document.getElementById('navCenter').textContent = `${currentIndex + 1} / ${filtered.length}`;
  document.getElementById('prevBtn').disabled = currentIndex === 0;
  document.getElementById('nextBtn').disabled = currentIndex === filtered.length - 1;

  dirty = false;
  setSaveStatus('');
  updateModifiedCount();
}

function setSaveStatus(msg, ok = true) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#2a8a4a' : '#a82a2a';
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
}
function setGlobalStatus(msg, ok = true) {
  const el = document.getElementById('globalStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? '#2a8a4a' : '#a82a2a';
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
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return false;
  const name = document.getElementById('editNameFr').value;
  const desc = document.getElementById('editDescFr').value;
  return name !== (card.name_fr || '')
      || normalizeNewlines(desc) !== normalizeNewlines(card.desc_fr);
}

function confirmDiscardIfDirty() {
  if (!hasUnsavedChanges()) return true;
  return confirm('Modifications non enregistrées sur cette carte. Continuer et les perdre ?');
}

// ============================================================================
// ÉCRITURE DANS LE .CDB
// ============================================================================
async function ensureFileHandle() {
  // Cas 1 : trad déjà chargée → demander la permission
  if (tradFileHandle) {
    const perm = await tradFileHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    const req = await tradFileHandle.requestPermission({ mode: 'readwrite' });
    return req === 'granted';
  }

  // Cas 2 : pas de trad → demander où créer le nouveau fichier
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
  const idNum = parseInt(card.id);

  const upd = frDb.prepare("UPDATE texts SET name = ?, desc = ? WHERE id = ?");
  upd.run([name_fr, desc_fr, idNum]);
  upd.free();

  const check = frDb.exec(`SELECT COUNT(*) FROM texts WHERE id = ${idNum}`);
  const exists = (check[0]?.values?.[0]?.[0] || 0) > 0;

  if (!exists) {
    const cols = ['id', 'name', 'desc'];
    const vals = [idNum, name_fr, desc_fr];
    for (let i = 1; i <= 16; i++) {
      cols.push('str' + i);
      vals.push('');
    }
    const placeholders = cols.map(() => '?').join(',');
    const ins = frDb.prepare(`INSERT INTO texts (${cols.join(',')}) VALUES (${placeholders})`);
    ins.run(vals);
    ins.free();
  }
}

function deleteDbCard(card) {
  if (!frDb) return;
  frDb.exec(`DELETE FROM texts WHERE id = ${parseInt(card.id)}`);
}

// ============================================================================
// ÉDITION INLINE
// ============================================================================
async function saveCurrentCard() {
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return;
  if (!supportsFS) { setSaveStatus('❌ Navigateur non compatible', false); return; }

  const name_fr = document.getElementById('editNameFr').value;
  const desc_fr = document.getElementById('editDescFr').value;

  updateDbForCard(card, name_fr, desc_fr);
  card.name_fr = name_fr;
  card.desc_fr = desc_fr;

  if (card.missingFr) {
    if (name_fr.trim() || desc_fr.trim()) card.missingFr = false;
    card.edited = (name_fr !== '') || (desc_fr !== '');
  } else {
    card.edited = (name_fr !== card.name_fr_orig)
               || (normalizeNewlines(desc_fr) !== normalizeNewlines(card.desc_fr_orig));
  }

  try {
    const ok = await ensureFileHandle();
    if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }
    await writeCdbToDisk();
    const target = tradFileName || 'nouveau fichier';
    setSaveStatus(`💾 Enregistré dans ${target}`, true);
  } catch (e) {
    console.error(e);
    setSaveStatus('❌ Erreur écriture : ' + e.message, false);
    return;
  }

  document.getElementById('modifiedBadge').style.display = card.edited ? '' : 'none';
  document.getElementById('vaactBadge').style.display = isVaactCard(card) ? '' : 'none';

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
    card.name_fr = '';
    card.desc_fr = '';
    card.edited = false;
    deleteDbCard(card);
    try {
      const ok = await ensureFileHandle();
      if (ok) await writeCdbToDisk();
      setSaveStatus('↺ Traduction supprimée', true);
    } catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); }
    render();
    return;
  }

  if (card.edited && !confirm('Réinitialiser cette carte à sa traduction d\'origine ?')) return;

  card.name_fr = card.name_fr_orig;
  card.desc_fr = card.desc_fr_orig;
  card.edited = false;
  updateDbForCard(card, card.name_fr, card.desc_fr);

  try {
    const ok = await ensureFileHandle();
    if (ok) await writeCdbToDisk();
    setSaveStatus('↺ Réinitialisé', true);
  } catch (e) {
    setSaveStatus('❌ Erreur : ' + e.message, false);
  }
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

if (filtersBtn && filtersPanel) {
  filtersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filtersPanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!filtersPanel.contains(e.target) && !filtersBtn.contains(e.target)) {
      filtersPanel.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') filtersPanel.classList.remove('open');
  });
}

// ============================================================================
// CHECKBOXES VAACT + Incomplètes
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
      <button type="button" class="chip-remove" data-keyword="${esc(kw)}" title="Retirer" aria-label="Retirer">✕</button>
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
  if (hasUnsavedChanges()) { e.preventDefault(); e.returnValue = ''; }
});

// ============================================================================
// UTIL
// ============================================================================
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ============================================================================
// THÈME
// ============================================================================
const THEME_KEY = 'vaact-theme';

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
}

document.getElementById('themeToggle').addEventListener('click', toggleTheme);

const themeToggleWelcome = document.getElementById('themeToggleWelcome');
if (themeToggleWelcome) {
  themeToggleWelcome.addEventListener('click', toggleTheme);
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

// ============================================================================
// INIT — boutons de l'écran d'accueil
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
