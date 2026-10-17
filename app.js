// ============================================================================
// Traducteur CDB — Logique applicative
// ----------------------------------------------------------------------------
// Éditeur de fichiers .cdb (SQLite) pour jeux Yu-Gi-Oh!
//   • Chargement des fichiers par l'utilisateur (aucun upload serveur)
//   • Édition des traductions (nom + description)
//   • 🆕 Édition des infos de la carte traduite (type, attribut, race,
//        ATK/DEF, niveau) → écrites dans la table `datas` du .cdb traduit
//   • 🆕 Trois colonnes : original (gauche) | textes (centre) | traduction (droite)
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

// État du formulaire d'infos (bloc de droite)
const LINK_BIT = 0x4000000;
let KNOWN_TYPE_MASK = 0;   // OU de tous les bits connus dans cardinfo
let formType = 0;          // valeur courante de la colonne `type`
let formTypeExtra = 0;     // bits de type inconnus de cardinfo (conservés tels quels)
let formLevelHigh = 0;     // bits hauts du level (échelles Pendule), conservés tels quels
let formDefBase = 0;       // valeur brute de `def` (flèches Lien : non éditable)

// ============================================================================
// SOURCES DE DONNÉES (repo ygo_outil_fr)
// ============================================================================
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

const $ = (id) => document.getElementById(id);

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
function raceToString(r) { return r ? (RACES[r] || `Race${r}`) : '—'; }

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
// INFOS DE CARTE (type, attribut, race, ATK, DEF, niveau)
// ============================================================================
const ZERO_INFO = { type: 0, atk: 0, def: 0, level: 0, race: 0, attribute: 0 };

function cloneInfo(i) {
  const s = i || ZERO_INFO;
  return {
    type: s.type ?? 0, atk: s.atk ?? 0, def: s.def ?? 0,
    level: s.level ?? 0, race: s.race ?? 0, attribute: s.attribute ?? 0,
  };
}

// Égalité stricte (utilisée pour savoir si le formulaire a été modifié)
function infoEqual(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && a.attribute === b.attribute && a.race === b.race
      && a.atk === b.atk && a.def === b.def && a.level === b.level;
}

// Différences EN / FR : renvoie la liste des champs qui diffèrent
// (le niveau est comparé sans les bits d'échelle Pendule)
function infoDiffKeys(en, fr) {
  if (!en || !fr) return [];
  const out = [];
  if (en.type !== fr.type) out.push('type');
  if (en.attribute !== fr.attribute) out.push('attribute');
  if (en.race !== fr.race) out.push('race');
  if (en.atk !== fr.atk) out.push('atk');
  if (en.def !== fr.def) out.push('def');
  if ((en.level & 0xff) !== (fr.level & 0xff)) out.push('level');
  return out;
}

function statToInput(v) {
  if (v === null || v === undefined) return '';
  if (v === -2 || v === -1) return '?';
  return String(v);
}

// Convertit le texte saisi en valeur brute. Si le texte n'a pas changé par
// rapport à l'affichage de la valeur d'origine, on garde l'original tel quel
// (ex. -1 reste -1 au lieu de devenir -2).
function parseStatKeep(text, orig) {
  const t = String(text || '').trim();
  if (t === statToInput(orig)) return orig ?? 0;
  if (t === '?') return -2;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : 0;
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
  const container = $('transTags');
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
    vaact: !!$('filterVaact')?.checked,
    incomplete: !!$('filterIncomplete')?.checked,
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
function currentCard() { return getFilteredCards()[currentIndex]; }

function updateFiltersBadge() {
  const btn = $('filtersBtn');
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
// avant la fin du délai, la demande est annulée.
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

// L'image est affichée dans les DEUX blocs (original à gauche, traduction à droite).
const CARD_IMG_IDS = ['cardImg', 'cardImgFr'];

function resetCardImg(imgEl, card) {
  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.removeAttribute('src');
  imgEl.style.display = 'none';
  imgEl.alt = card?.name_fr || card?.name_en || 'Carte';
  ensurePlaceholder(imgEl.parentElement);
}

async function loadCardImage(card) {
  const imgs = CARD_IMG_IDS.map(id => $(id)).filter(Boolean);
  if (!imgs.length) return;

  clearTimeout(imageTimer);
  imgs.forEach(imgEl => resetCardImg(imgEl, card));

  imageTimer = setTimeout(async () => {
    const url = await fetchCardImage(card);
    if (currentCard() !== card) return;
    if (!url) return;

    imgs.forEach(imgEl => {
      const parent = imgEl.parentElement;
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
    });
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
      $('cardSource').classList.add('picked');
      $('subSource').textContent = h.name;
    } else {
      tradFileHandle = h;
      tradFileName = h.name;
      $('cardTrad').classList.add('picked');
      $('subTrad').textContent = h.name;
    }
    $('startBtn').disabled = !sourceFileHandle;
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
}

// ============================================================================
// CRÉATION D'UNE BASE FR VIDE
// ============================================================================
const DATAS_SCHEMA = `CREATE TABLE IF NOT EXISTS datas (
    id integer primary key,
    ot integer, alias integer, setcode integer,
    type integer, atk integer, def integer, level integer,
    race integer, attribute integer, category integer
  )`;

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
  db.run(DATAS_SCHEMA);
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

  const lt = $('loadingText');
  $('loadingScreen').style.display = 'flex';
  $('welcomeScreen').style.display = 'none';

  try {
    lt.textContent = 'Chargement du cardinfo…';
    await loadCardInfo(CARDINFO_URL);
    buildInfoControls();

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

    $('loadingScreen').style.display = 'none';
    $('appScreen').style.display = 'block';
    document.body.classList.add('has-nav');
    updateTopbarHeight();

    renderCustomChips();
    updateFiltersBadge();
    render();

  } catch (err) {
    console.error('❌', err);
    setGlobalStatus('Erreur de chargement : ' + err.message, false);
    $('loadingScreen').style.display = 'none';
    $('welcomeScreen').style.display = 'flex';
  }
}

// ============================================================================
// EXTRACTION
// ============================================================================
// Renvoie, pour chaque id : texte (name, desc), `data` (type, atk, def, level,
// race, attribute — null si pas de ligne dans `datas`) et `extra` (colonnes
// qu'on ne modifie pas : ot, alias, setcode, category).
function extractCards(db) {
  const t = db.exec("SELECT id, name, desc FROM texts")[0];
  if (!t) return {};

  let d = null;
  try { d = db.exec("SELECT * FROM datas")[0]; } catch { d = null; }

  const dById = {};
  if (d) {
    const ci = {};
    d.columns.forEach((c, i) => { ci[c] = i; });
    for (const row of d.values) {
      const g = (k) => (k in ci ? row[ci[k]] : null);
      dById[String(row[ci.id])] = {
        data: {
          type: g('type') ?? 0, atk: g('atk') ?? 0, def: g('def') ?? 0,
          level: g('level') ?? 0, race: g('race') ?? 0, attribute: g('attribute') ?? 0,
        },
        extra: { ot: g('ot'), alias: g('alias'), setcode: g('setcode'), category: g('category') },
      };
    }
  }

  const out = {};
  for (const [id, name, desc] of t.values) {
    const k = String(id);
    out[k] = {
      id: k, name: name || '', desc: desc || '',
      data: dById[k]?.data || null,
      extra: dById[k]?.extra || null,
    };
  }
  return out;
}

// ============================================================================
// FUSION
// ============================================================================
// Pour chaque carte :
//   en_data         infos de l'original (null si la carte n'existe que côté FR)
//   fr_info         infos « effectives » de la traduction (ce qu'affiche le bloc droit)
//                   = ligne `datas` du .cdb traduit, sinon copie de l'original
//   fr_info_orig    ligne `datas` d'origine du .cdb traduit (null s'il n'y en avait pas)
//   fr_info_base    référence pour savoir si les infos ont été éditées
//   has_fr_datas    true si le .cdb traduit contient une ligne `datas` pour cette carte
function mergeCards(sourceCards, tradCards) {
  const result = [];
  for (const id in sourceCards) {
    const en = sourceCards[id];
    const fr = tradCards[id];
    const en_data = en.data ? cloneInfo(en.data) : null;
    const frData = fr && fr.data ? cloneInfo(fr.data) : null;
    const fr_info = frData ? cloneInfo(frData) : cloneInfo(en_data);
    const fr_info_base = frData ? cloneInfo(frData) : cloneInfo(en_data);

    if (!fr) {
      result.push({
        id: en.id,
        name_en: en.name, desc_en: en.desc,
        name_fr: '', desc_fr: '',
        name_fr_orig: '', desc_fr_orig: '',
        en_data, fr_info, fr_info_orig: null, fr_info_base,
        has_fr_datas: false,
        src_extra: en.extra, fr_extra: null,
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
      en_data, fr_info, fr_info_orig: frData ? cloneInfo(frData) : null, fr_info_base,
      has_fr_datas: !!frData,
      src_extra: en.extra, fr_extra: fr.extra,
      edited: false,
    });
  }
  for (const id in tradCards) {
    if (sourceCards[id]) continue;
    const fr = tradCards[id];
    const name_fr = normalizeNewlines(fr.name);
    const desc_fr = normalizeNewlines(fr.desc);
    const frData = fr.data ? cloneInfo(fr.data) : null;
    result.push({
      id: fr.id,
      name_en: '', desc_en: '',
      name_fr, desc_fr,
      name_fr_orig: name_fr, desc_fr_orig: desc_fr,
      en_data: null,
      fr_info: cloneInfo(frData), fr_info_orig: frData ? cloneInfo(frData) : null,
      fr_info_base: cloneInfo(frData),
      has_fr_datas: !!frData,
      src_extra: null, fr_extra: fr.extra,
      edited: false,
      missingEn: true,
    });
  }
  result.sort((a, b) => parseInt(a.id) - parseInt(b.id));
  return result;
}

// ============================================================================
// FORMULAIRE D'INFOS (bloc de droite)
// ============================================================================
function buildInfoControls() {
  KNOWN_TYPE_MASK = TYPES.reduce((m, t) => m | t.v, 0);

  $('typePanelFr').innerHTML = TYPES.map(t =>
    `<label class="type-opt"><input type="checkbox" data-v="${t.v}"><span>${esc(t.label)}</span></label>`
  ).join('');

  const optionsOf = (map) =>
    '<option value="0">—</option>' +
    Object.keys(map).map(Number).sort((a, b) => a - b)
      .map(v => `<option value="${v}">${esc(map[v])}</option>`).join('');

  $('attrSelFr').innerHTML = optionsOf(ATTRIBUTES);
  $('raceSelFr').innerHTML = optionsOf(RACES);
}

// Sélectionne une valeur dans un <select>, en l'ajoutant si elle est inconnue
function setSelectValue(sel, val, prefix) {
  const v = String(val ?? 0);
  if (![...sel.options].some(o => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = `${prefix}${v}`;
    sel.appendChild(o);
  }
  sel.value = v;
}

function updateTypeSummary() {
  const btn = $('typeToggleFr');
  if (btn) btn.textContent = typeToString(formType) + ' ▾';
}

// DEF d'un monstre Lien = bitmask des flèches : non éditable ici
function syncDefState() {
  const defEl = $('defInputFr');
  if (!defEl) return;
  if ((formType & LINK_BIT) !== 0) {
    defEl.disabled = true;
    defEl.value = '⇗';
    defEl.title = 'Monstre Lien : DEF = flèches (non modifiables ici)';
  } else {
    if (defEl.disabled) defEl.value = statToInput(formDefBase);
    defEl.disabled = false;
    defEl.title = '';
  }
}

function setInfoFormDisabled(disabled) {
  ['typeToggleFr', 'attrSelFr', 'raceSelFr', 'atkInputFr', 'defInputFr', 'levelInputFr'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
  if (disabled) $('typePanelFr').classList.remove('open');
}

function setInfoForm(info) {
  const i = cloneInfo(info);
  formType = i.type;
  formTypeExtra = i.type & ~KNOWN_TYPE_MASK;
  formLevelHigh = i.level & ~0xff;
  formDefBase = i.def;

  $('typePanelFr').querySelectorAll('input').forEach(cb => {
    cb.checked = (i.type & Number(cb.dataset.v)) !== 0;
  });
  $('typePanelFr').classList.remove('open');
  setSelectValue($('attrSelFr'), i.attribute, 'Attr');
  setSelectValue($('raceSelFr'), i.race, 'Race');
  $('atkInputFr').value = statToInput(i.atk);
  $('defInputFr').value = statToInput(i.def);
  $('levelInputFr').value = String(i.level & 0xff);

  setInfoFormDisabled(false);
  updateTypeSummary();
  syncDefState();
}

function readInfoForm(card) {
  const base = card.fr_info;
  const lv = Math.max(0, Math.min(255, parseInt($('levelInputFr').value, 10) || 0));
  return {
    type: formType,
    attribute: Number($('attrSelFr').value) || 0,
    race: Number($('raceSelFr').value) || 0,
    atk: parseStatKeep($('atkInputFr').value, base.atk),
    def: $('defInputFr').disabled ? formDefBase : parseStatKeep($('defInputFr').value, base.def),
    level: formLevelHigh | lv,
  };
}

// Remplit le bloc de gauche (original)
function fillLeftInfo(card) {
  const en = card ? card.en_data : null;
  $('infoId').textContent = card ? (card.id || '—') : '—';
  $('infoType').textContent = en ? typeToString(en.type) : '—';
  $('infoAttr').textContent = en ? attributeToString(en.attribute) : '—';
  $('infoRace').textContent = en ? raceToString(en.race) : '—';
  $('infoStats').textContent = en ? formatStat(en.atk) + ' / ' + formatStat(en.def) : '—';
  $('infoLevel').textContent = en ? String(en.level & 0xff) : '—';
}

// Surligne en rouge les lignes qui diffèrent entre l'original et la traduction
// (mis à jour en direct pendant la saisie)
function updateDiffs() {
  const card = currentCard();
  const rows = [
    ['infoType', 'typeToggleFr', ['type']],
    ['infoAttr', 'attrSelFr', ['attribute']],
    ['infoRace', 'raceSelFr', ['race']],
    ['infoStats', 'atkInputFr', ['atk', 'def']],
    ['infoLevel', 'levelInputFr', ['level']],
  ];
  let diffs = [];
  if (card && card.en_data) diffs = infoDiffKeys(card.en_data, readInfoForm(card));
  rows.forEach(([leftId, rightId, keys]) => {
    const differs = keys.some(k => diffs.includes(k));
    $(leftId).closest('.info-row').classList.toggle('diff', differs);
    $(rightId).closest('.info-row').classList.toggle('diff', differs);
  });
}

function statusText(card) {
  return card.missingFr ? '⚠️ À traduire'
       : card.missingEn ? '⚠️ Orpheline'
       : card.edited ? '✏️ Modifiée' : '✔️ Traduite';
}

function updateInfoMeta(card) {
  $('infoStatus').textContent = statusText(card);
  const hint = $('infoFrHint');
  if (hint) {
    hint.textContent = (!card.has_fr_datas && card.en_data)
      ? 'Valeurs héritées de l\'original — modifie un champ pour les enregistrer dans la traduction.'
      : '';
    hint.style.display = hint.textContent ? '' : 'none';
  }
}

function onInfoChanged() {
  updateDiffs();
  markDirty();
}

// ============================================================================
// RENDER
// ============================================================================
function render() {
  if (!CARDS.length) return;
  const filtered = getFilteredCards();

  if (!filtered.length) {
    fillLeftInfo(null);
    $('infoIdFr').textContent = '—';
    $('infoStatus').textContent = 'Aucune carte';
    $('origName').textContent = '—';
    $('origDesc').textContent = 'Aucune carte ne correspond aux filtres actifs.';
    clearTimeout(imageTimer);
    CARD_IMG_IDS.forEach(id => { const el = $(id); if (el) resetCardImg(el, null); });
    setInfoForm(ZERO_INFO);
    setInfoFormDisabled(true);
    updateDiffs();
    const hint = $('infoFrHint'); if (hint) hint.style.display = 'none';
    const nameEl = $('editNameFr');
    const descEl = $('editDescFr');
    if (nameEl) { nameEl.value = ''; nameEl.disabled = true; }
    if (descEl) { descEl.value = ''; descEl.disabled = true; }
    const tagsEl = $('transTags');
    if (tagsEl) tagsEl.innerHTML = '';
    const mb = $('missingBadge');
    if (mb) mb.style.display = 'none';
    const modb = $('modifiedBadge');
    if (modb) modb.style.display = 'none';
    $('navCenter').textContent = '0 / 0';
    $('prevBtn').disabled = true;
    $('nextBtn').disabled = true;
    return;
  }

  const nameEl = $('editNameFr');
  const descEl = $('editDescFr');
  if (nameEl) nameEl.disabled = false;
  if (descEl) descEl.disabled = false;

  if (currentIndex >= filtered.length) currentIndex = 0;
  const card = filtered[currentIndex];

  dirty = false;
  loadCardImage(card);

  // Bloc gauche (original) + bloc droit (traduction)
  fillLeftInfo(card);
  $('infoIdFr').textContent = card.id || '—';
  setInfoForm(card.fr_info);
  updateDiffs();
  updateInfoMeta(card);

  $('origName').textContent = card.name_en || '—';
  $('origDesc').textContent = card.desc_en || '—';
  $('editNameFr').value = card.name_fr || '';
  $('editDescFr').value = card.desc_fr || '';

  renderTags(card.desc_fr);
  $('modifiedBadge').style.display = card.edited ? '' : 'none';

  const mb = $('missingBadge');
  if (mb) {
    if (card.missingFr) { mb.textContent = '⚠️ Traduction manquante'; mb.style.display = ''; }
    else if (card.missingEn) { mb.textContent = '⚠️ Original manquant'; mb.style.display = ''; }
    else mb.style.display = 'none';
  }

  $('navCenter').textContent = `${currentIndex + 1} / ${filtered.length}`;
  $('prevBtn').disabled = currentIndex === 0;
  $('nextBtn').disabled = currentIndex === filtered.length - 1;

  setSaveStatus('');
  updateModifiedCount();
}

function setSaveStatus(msg, ok = true) {
  const el = $('saveStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !ok && !!msg);
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
}
function setGlobalStatus(msg, ok = true) {
  const el = $('globalStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !ok && !!msg);
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3500);
}
function updateModifiedCount() {
  const wrap = $('modifiedCount');
  const val = $('modifiedCountValue');
  if (!wrap || !val) return;
  const n = CARDS.filter(c => c.edited).length;
  val.textContent = String(n);
  wrap.style.display = n > 0 ? '' : 'none';
}
function hasUnsavedChanges() {
  const nameEl = $('editNameFr');
  const descEl = $('editDescFr');
  if (!nameEl || !descEl) return false;
  const card = currentCard();
  if (!card) return false;
  if (nameEl.value !== (card.name_fr || '')) return true;
  if (normalizeNewlines(descEl.value) !== normalizeNewlines(card.desc_fr)) return true;
  return !infoEqual(readInfoForm(card), card.fr_info);
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
    $('subTrad').textContent = h.name;
    $('cardTrad').classList.add('picked');
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
function getColumns(db, t) {
  const r = db.exec(`PRAGMA table_info(${t})`)[0];
  return r ? r.values.map(row => row[1]) : [];
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

// 🆕 Écrit les infos (type, atk, def, level, race, attribute) dans `datas`.
// Si la ligne existe déjà, on ne met à jour que ces 6 colonnes (les autres
// — ot, alias, setcode, category — sont conservées). Sinon on crée la ligne en
// recopiant ces colonnes depuis le .cdb source.
function updateDbDatas(card, info) {
  if (!frDb) return;
  const idNum = parseInt(card.id, 10);
  if (!Number.isFinite(idNum)) return;
  frDb.run(DATAS_SCHEMA);
  const cols = getColumns(frDb, 'datas');
  const vals = { type: info.type, atk: info.atk, def: info.def, level: info.level, race: info.race, attribute: info.attribute };

  const exists = frDb.exec(`SELECT 1 FROM datas WHERE id = ${idNum}`)[0];
  if (exists) {
    const set = Object.keys(vals).filter(k => cols.includes(k));
    frDb.run(`UPDATE datas SET ${set.map(k => k + ' = ?').join(', ')} WHERE id = ?`,
      [...set.map(k => vals[k]), idNum]);
  } else {
    const ex = card.fr_extra || card.src_extra || {};
    const all = {
      id: idNum, ot: ex.ot ?? 0, alias: ex.alias ?? 0, setcode: ex.setcode ?? 0,
      category: ex.category ?? 0, ...vals,
    };
    const use = cols.filter(c => c in all);
    frDb.run(`INSERT INTO datas (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`,
      use.map(c => all[c]));
  }
}
function deleteDbDatas(card) {
  if (!frDb) return;
  const idNum = parseInt(card.id, 10);
  if (!Number.isFinite(idNum)) return;
  try { frDb.run("DELETE FROM datas WHERE id = ?", [idNum]); } catch (e) {}
}

// Revient aux infos « héritées » de l'original (aucune ligne `datas` côté FR)
function inheritInfoFromOriginal(card) {
  deleteDbDatas(card);
  card.fr_info = cloneInfo(card.en_data);
  card.fr_info_base = cloneInfo(card.en_data);
  card.has_fr_datas = false;
}

// ============================================================================
// ÉDITION
// ============================================================================
async function saveCurrentCard() {
  const card = currentCard();
  if (!card) return;
  if (!supportsFS) { setSaveStatus('❌ Navigateur non compatible', false); return; }

  const name_fr = $('editNameFr').value;
  const desc_fr = $('editDescFr').value;
  const info = readInfoForm(card);
  const infoChanged = !infoEqual(info, card.fr_info);

  let ok;
  try { ok = await ensureFileHandle(); }
  catch (e) { setSaveStatus('❌ Erreur accès fichier : ' + e.message, false); return; }
  if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }

  updateDbForCard(card, name_fr, desc_fr);
  card.name_fr = name_fr;
  card.desc_fr = desc_fr;

  if (infoChanged) {
    updateDbDatas(card, info);
    card.fr_info = info;
    card.has_fr_datas = true;
  }
  const infoEdited = !infoEqual(card.fr_info, card.fr_info_base);

  if (card.missingFr) {
    if (name_fr.trim() || desc_fr.trim()) card.missingFr = false;
    card.edited = (name_fr.trim() !== '') || (desc_fr.trim() !== '') || infoEdited;
  } else {
    card.edited = (name_fr !== card.name_fr_orig)
               || (normalizeNewlines(desc_fr) !== normalizeNewlines(card.desc_fr_orig))
               || infoEdited;
  }

  try {
    await writeCdbToDisk();
    setSaveStatus(`💾 Enregistré dans ${tradFileName || 'nouveau fichier'}`, true);
  } catch (e) { setSaveStatus('❌ Erreur écriture : ' + e.message, false); return; }

  renderTags(card.desc_fr);
  $('modifiedBadge').style.display = card.edited ? '' : 'none';
  const mb = $('missingBadge');
  if (mb) {
    if (card.missingFr) { mb.textContent = '⚠️ Traduction manquante'; mb.style.display = ''; }
    else if (card.missingEn) { mb.textContent = '⚠️ Original manquant'; mb.style.display = ''; }
    else mb.style.display = 'none';
  }
  updateInfoMeta(card);
  updateDiffs();

  dirty = false;
  updateModifiedCount();
}

async function resetCurrentCard() {
  const card = currentCard();
  if (!card) return;

  if (card.missingFr) {
    if ((card.name_fr || card.desc_fr || card.has_fr_datas) && !confirm('Vider cette traduction ?')) return;
    let ok;
    try { ok = await ensureFileHandle(); }
    catch (e) { setSaveStatus('❌ Erreur : ' + e.message, false); return; }
    if (!ok) { setSaveStatus('⚠️ Autorisation refusée', false); return; }
    card.name_fr = ''; card.desc_fr = ''; card.edited = false;
    deleteDbCard(card);
    inheritInfoFromOriginal(card);
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

  // Infos : on remet la ligne `datas` d'origine, ou on la supprime s'il n'y en avait pas
  if (card.fr_info_orig) {
    card.fr_info = cloneInfo(card.fr_info_orig);
    card.fr_info_base = cloneInfo(card.fr_info_orig);
    updateDbDatas(card, card.fr_info);
    card.has_fr_datas = true;
  } else if (card.en_data) {
    inheritInfoFromOriginal(card);
  }

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

$('prevBtn').addEventListener('click', goPrev);
$('nextBtn').addEventListener('click', goNext);
$('randomBtn').addEventListener('click', goRandom);
$('saveBtn').addEventListener('click', saveCurrentCard);
$('resetCardBtn').addEventListener('click', resetCurrentCard);

// ============================================================================
// ÉVÉNEMENTS DU FORMULAIRE D'INFOS
// ============================================================================
$('typeToggleFr').addEventListener('click', () => {
  $('typePanelFr').classList.toggle('open');
});
// La liste des types se ferme quand on clique ailleurs ou qu'on appuie sur Échap
document.addEventListener('click', (e) => {
  const panel = $('typePanelFr');
  if (!panel.classList.contains('open')) return;
  if (panel.contains(e.target) || $('typeToggleFr').contains(e.target)) return;
  panel.classList.remove('open');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('typePanelFr').classList.remove('open');
});
$('typePanelFr').addEventListener('change', () => {
  let sum = 0;
  $('typePanelFr').querySelectorAll('input:checked').forEach(cb => { sum |= Number(cb.dataset.v); });
  formType = formTypeExtra | sum;
  updateTypeSummary();
  syncDefState();
  onInfoChanged();
});
$('attrSelFr').addEventListener('change', onInfoChanged);
$('raceSelFr').addEventListener('change', onInfoChanged);
$('atkInputFr').addEventListener('input', onInfoChanged);
$('defInputFr').addEventListener('input', onInfoChanged);
$('levelInputFr').addEventListener('input', onInfoChanged);

// ============================================================================
// PANNEAU FILTRES
// ============================================================================
const filtersBtn = $('filtersBtn');
const filtersPanel = $('filtersPanel');

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
  const el = $(id);
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
const customInput = $('customKeywordInput');
const customAddBtn = $('customAddBtn');
const customChips = $('customChips');
const customResetBtn = $('filterResetBtn');

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
    const v = $('filterVaact');
    const i = $('filterIncomplete');
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
const searchInput = $('searchInput');
const searchClear = $('searchClear');

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
$('editNameFr').addEventListener('input', markDirty);
$('editDescFr').addEventListener('input', markDirty);

// ============================================================================
// RACCOURCIS CLAVIER
// ============================================================================
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCurrentCard();
    return;
  }
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
  const btn = $('themeToggle');
  if (btn) btn.textContent = icon;
  const btnW = $('themeToggleWelcome');
  if (btnW) btnW.textContent = icon;
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  const card = currentCard();
  if (card) renderTags(card.desc_fr);
}

$('themeToggle').addEventListener('click', toggleTheme);

const themeToggleWelcome = $('themeToggleWelcome');
if (themeToggleWelcome) {
  themeToggleWelcome.addEventListener('click', toggleTheme);
}

applyTheme(localStorage.getItem(THEME_KEY) || 'light');

// ============================================================================
// INIT
// ============================================================================
$('pickSourceBtn').addEventListener('click', () => pickCdb('source'));
$('pickTradBtn').addEventListener('click', () => pickCdb('trad'));
$('startBtn').addEventListener('click', startApp);

if (!supportsFS) {
  const btn = $('startBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '❌ Navigateur non compatible';
  }
}
