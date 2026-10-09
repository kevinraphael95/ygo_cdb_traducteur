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
let sourceFileHandle = null;    // deck à traduire (requis)
let tradFileHandle = null;      // traduction existante (optionnel)
let tradFileName = '';
let supportsFS = 'showOpenFilePicker' in window && 'showSaveFilePicker' in window;
let customKeywords = [];
const CUSTOM_KEYWORDS_LS = 'cdb-translator-keywords';

// Timeout pour les requêtes d'images vers YGOPRODeck.
const IMAGE_FETCH_TIMEOUT_MS = 8000;
// TTL du cache localStorage des URLs d'images : 30 jours.
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
// TAGS AUTO — détecte [XXX] dans les descriptions
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
// IMAGES — cache double (mémoire + localStorage) + timeout
// ============================================================================
// Clé de cache = card.id (unique). Le nom peut être partagé par plusieurs
// cartes (alt-arts, rééditions) → collision.
const imageCache = {};

async function fetchCardImage(card) {
  if (!card || !card.id) return null;
  const key = card.id;

  if (imageCache[key] !== undefined) return imageCache[key];

  // Cache localStorage avec TTL : on stocke { url, ts }.
  const lsKey = 'img_' + key;
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.ts === 'number'
          && Date.now() - parsed.ts < IMAGE_CACHE_TTL_MS) {
        imageCache[key] = parsed.url;
        return parsed.url;
      }
    }
  } catch (e) { /* format ancien ou stockage indisponible : on ignore */ }

  const name = card.name_en || card.name_fr;
  if (!name) {
    imageCache[key] = null;
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const url = `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      imageCache[key] = null;
      return null;
    }
    const data = await res.json();
    const imgUrl = data.data?.[0]?.card_images?.[0]?.image_url_cropped
                || data.data?.[0]?.card_images?.[0]?.image_url
                || null;
    imageCache[key] = imgUrl;
    if (imgUrl) {
      try {
        localStorage.setItem(lsKey, JSON.stringify({ url: imgUrl, ts: Date.now() }));
      } catch (e) {}
    }
    return imgUrl;
  } catch (err) {
    clearTimeout(timer);
    imageCache[key] = null;
    return null;
  }
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

  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';
  imgEl.alt = card?.name_fr || card?.name_en || 'Carte';

  const parent = imgEl.parentElement;
  ensurePlaceholder(parent);

  const url = await fetchCardImage(card);

  if (getFilteredCards()[currentIndex] !== card) return;
  if (!url) return;

  // On retire le placeholder seulement après confirmation du chargement.
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
}

// ============================================================================
// SÉLECTION DES FICHIERS PAR L'UTILISATEUR
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

    // Validation rapide du header SQLite avant d'aller plus loin.
    try {
      const file = await h.getFile();
      const header = new TextDecoder().decode((await file.slice(0, 16).arrayBuffer()));
      if (!header.startsWith('SQLite format 3')) {
        setGlobalStatus('Ce fichier n\'est pas un .cdb valide.', false);
        return;
      }
    } catch (e) {
      /* on continue quand même, la vraie erreur remontera au démarrage */
    }

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
// Le schéma inclut str1..str16 (compatibilité avec d'autres lecteurs de cdb
// Yu-Gi-Oh!) mais on ne les remplit pas — ils restent vides.
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
    setGlobalStatus('Il faut sélectionner un deck à traduire pour commencer.', false);
    return;
  }

  const lt = document.getElementById('loadingText');
  document.getElementById('loadingScreen').style.display = 'flex';
  document.getElementById('welcomeScreen').style.display = 'none';

  try {
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

    // La DB source n'est plus utilisée : on libère la mémoire WASM.
    sourceDb.close();

    const missingFr = CARDS.filter(c => c.missingFr).length;
    const missingEn = CARDS.filter(c => c.missingEn).length;
    console.log(`✅ ${CARDS.length} cartes chargées`);
    console.log(`   • ${missingFr} sans traduction`);
    console.log(`   • ${missingEn} sans original`);

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

  if (sourceOnly.length) console.warn(`⚠️ ${sourceOnly.length} carte(s) sans traduction`);
  if (tradOnly.length) console.warn(`⚠️ ${tradOnly.length} carte(s) traduites sans original`);
  if (!sourceOnly.length && !tradOnly.length && Object.keys(sourceCards).length && Object.keys(tradCards).length) {
    console.log('✅ Aucune carte orpheline');
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
    document.getElementById('infoId').textContent = '—';
    document.getElementById('infoType').textContent = '—';
    document.getElementById('infoAttr').textContent = '—';
    document.getElementById('infoStats').textContent = '—';
    document.getElementById('infoLevel').textContent = '—';
    document.getElementById('infoStatus').textContent = 'Aucune carte';
    document.getElementById('origName').textContent = '—';
    document.getElementById('origDesc').textContent = 'Aucune carte ne correspond aux filtres actifs.';

    const imgEl = document.getElementById('cardImg');
    if (imgEl) {
      imgEl.onload = null;
      imgEl.onerror = null;
      imgEl.removeAttribute('src');
      imgEl.style.display = 'none';
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
  // NOTE : on ne touche PAS `dirty` ici. C'est `markDirty` / `saveCurrentCard`
  // / `resetCurrentCard` qui gèrent ce flag. Avant, `render()` remettait
  // dirty = false, ce qui pouvait perdre des modifs silencieusement.
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

  const name = nameEl.value;
  const desc = descEl.value;

  return name !== (card.name_fr || '')
      || normalizeNewlines(desc) !== normalizeNewlines(card.desc_fr);
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

// Écrit (ou remplace) une ligne dans `texts`. Un seul appel SQL :
// INSERT OR REPLACE fait l'update si la ligne existe, sinon l'insert.
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
// ÉDITION INLINE
// ============================================================================
async function saveCurrentCard() {
  const f = getFilteredCards();
  const card = f[currentIndex];
  if (!card) return;
  if (!supportsFS) { setSaveStatus('❌ Navigateur non compatible', false); return; }

  const name_fr = document.getElementById('editNameFr').value;
  const desc_fr = document.getElementById('editDescFr').value;

  // 1) Permission d'écriture AVANT de toucher quoi que ce soit en mémoire.
  let ok;
  try {
    ok = await ensureFileHandle();
  } catch (e) {
    console.error(e);
    setSaveStatus('❌ Erreur accès fichier : ' + e.message, false);
    return;
  }
  if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

  // 2) Modification de la DB et de l'objet carte.
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

  // 3) Écriture sur disque.
  try {
    await writeCdbToDisk();
    setSaveStatus(`💾 Enregistré dans ${tradFileName || 'nouveau fichier'}`, true);
  } catch (e) {
    console.error(e);
    setSaveStatus('❌ Erreur écriture : ' + e.message, false);
    return;
  }

  // 4) Rafraîchissement de l'UI.
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
    try {
      ok = await ensureFileHandle();
    } catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); return; }
    if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

    card.name_fr = '';
    card.desc_fr = '';
    card.edited = false;
    deleteDbCard(card);

    try {
      await writeCdbToDisk();
      setSaveStatus('↺ Traduction supprimée', true);
    } catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); }
    render();
    return;
  }

  if (card.edited && !confirm('Réinitialiser cette carte à sa traduction d\'origine ?')) return;

  let ok;
  try {
    ok = await ensureFileHandle();
  } catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); return; }
  if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

  card.name_fr = card.name_fr_orig;
  card.desc_fr = card.desc_fr_orig;
  card.edited = false;
  updateDbForCard(card, card.name_fr, card.desc_fr);

  try {
    await writeCdbToDisk();
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
// On utilise `dirty` (le vrai flag d'état) plutôt que hasUnsavedChanges(),
// plus fiable vis-à-vis de la carte filtrée.
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

// La topbar peut changer de hauteur (wrap en mobile, etc.). On expose sa
// hauteur réelle en CSS via --topbar-height pour que le panneau filtres
// mobile s'ancre correctement.
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

  // Les couleurs des tags dépendent du thème : on re-render la carte courante.
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
