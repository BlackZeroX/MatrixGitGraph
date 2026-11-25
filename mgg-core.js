(() => {
  if (window.__MGG_CORE_INIT__) return;
  window.__MGG_CORE_INIT__ = true;

  const CONSTANTS = {
    ROW_HEIGHT: 26,
    DEFAULT_BRANCH_COL_WIDTH: 96,
    MIN_BRANCH_COL_WIDTH: 46,
    MAX_BRANCH_COL_WIDTH: 340,
    SUB_LANE_STEP: 14,
    COMPACT_LANE_WIDTH: 18,
    COMPACT_PAD_X: 14,

    PARENT_CACHE_STORAGE_KEY: 'mgg_parents_cache_v1',
    REPO_CONFIGS_STORAGE_KEY: 'mgg_repo_configs_v2',
    LEGACY_REPO_PREFS_KEY: 'mgg_repo_prefs_v1',
    MAX_CACHED_SHAS_PER_REPO: 3000,
    MAX_NAV_HISTORY: 60,

    DEFAULT_META_ORDER: ['msg', 'sha', 'author', 'date'],
    DEFAULT_META_WIDTHS: { msg: null, sha: 78, author: 135, date: 132 },
    META_COL_LABELS: {
      msg: 'Commit / Referencias',
      sha: 'Hash',
      author: 'Autor',
      date: 'Fecha'
    },

    MATRIX_PALETTE: [
      '#00ff41', // Matrix Classic Green
      '#00f0ff', // Cyber Cyan
      '#b8ff00', // Acid Lime
      '#00ffa2', // Neon Emerald
      '#ffea00', // Phosphor Yellow
      '#39ff14', // Radioactive Green
      '#00b8ff', // Electric Blue
      '#7fffd4', // Aquamarine
      '#76ff03', // Bright Chartreuse
      '#1de9b6', // Matrix Teal
      '#c6ff00', // Bio Lime
      '#64ffda'  // Soft Cyber Mint
    ],

    RESERVED_PATHS: new Set([
      'settings', 'notifications', 'explore', 'marketplace', 'pulls', 'issues',
      'orgs', 'new', 'login', 'logout', 'signup', 'search', 'topics', 'trending',
      'sponsors', 'features', 'pricing', 'enterprise', 'organizations', 'about',
      'security', 'codespaces', 'stars', 'watching', 'account', 'sessions'
    ])
  };

  const state = {
    repo: null,

    // Globales (compartidas entre repositorios)
    tokens: [],
    activeTokenIndex: 0,
    autoRotate: true,
    anonRateRemaining: null,

    // Configuración persistida por repositorio
    hasSavedRepoConfig: false,
    connectionMode: 'auto',     // 'auto' | 'web' | 'api'
    graphLayout: 'columns',     // 'columns' | 'sourcetree'
    arrowMode: 'all',           // 'all' | 'integrations' | 'none'
    branchSort: 'alpha_asc',    // 'alpha_asc' | 'alpha_desc' | 'date_desc' | 'date_asc'
    shortHeaders: true,
    showTags: true,
    commitsPerBranch: 100,

    // Tamaños de paneles redimensionables (por repositorio)
    sidebarWidth: 280,
    tagsHeight: 155,
    tokenDrawerHeight: null,
    detailHeight: 290,
    detailLeftWidth: 350,
    detailMsgHeight: 72,
    explorerSidebarWidth: 300,
    diffViewMode: 'split',      // 'split' | 'unified'
    sourceTreeGraphWidth: null,
    customColumnOrder: [],
    columnWidths: {},
    metaColumnOrder: [...CONSTANTS.DEFAULT_META_ORDER],
    metaWidths: { ...CONSTANTS.DEFAULT_META_WIDTHS },
    selectedBranches: new Set(),
    collapsedFolders: new Set(),
    tagsCollapsed: false,

    // Estado en memoria del repositorio activo
    activeSource: 'api',
    branches: [],
    tags: [],                   // [{ name, sha, timestamp }]
    tagsBySha: new Map(),       // sha -> [tagName, ...]
    branchFilter: '',
    orderedCommits: [],
    commitMap: new Map(),
    branchHeadMap: new Map(),

    // Selección múltiple y navegación (Inicio / Atrás / Adelante / Limpiar)
    activeSha: null,
    selectedShas: new Set(),
    lastAnchorSha: null,
    navHistory: [],             // [{ activeSha, shas: [...] }]
    navIndex: -1,

    isLoading: false,
    parentsCache: new Map(),
    isFetchingBranchDates: false,

    // Estado del Explorador de Archivos / Diff / Historial
    explorer: {
      isOpen: false,
      commitSha: null,
      commit: null,
      files: [],
      selectedFileIdx: 0,
      activeTab: 'diff',        // 'diff' | 'history'
      fileFilter: '',
      changeAnchors: [],
      currentChangeIdx: -1,
      commitDiffCache: new Map(), // sha -> { files, stats }
      fileHistoryCache: new Map() // `${sha}::${path}` -> [commits]
    }
  };

  const ui = {
    stickyBtn: null,
    overlay: null
  };

  // Callbacks registrados por content.js para comunicación entre módulos
  const callbacks = {
    setStatus: () => {},
    updateRateDisplay: () => {},
    updateControlsUI: () => {},
    loadRepoData: () => {},
    renderBranchSidebar: () => {},
    renderGraph: () => {},
    selectAndScrollToSha: () => {},
    showCommitDetails: () => {}
  };

  // =====================================================================
  // UTILIDADES GENERALES
  // =====================================================================

  function escapeHtml(str) {
    const el = document.createElement('div');
    el.textContent = String(str ?? '');
    const amp = String.fromCharCode(38);
    const dq = String.fromCharCode(34);
    const sq = String.fromCharCode(39);
    return el.innerHTML
      .split(dq).join(amp + 'quot;')
      .split(sq).join(amp + '#39;');
  }

  function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function sanitizeToken(raw) {
    return String(raw || '').replace(/[^\x21-\x7E]/g, '').trim();
  }

  function maskToken(val) {
    if (!val) return '';
    if (val.length <= 10) return '••••••';
    return `${val.slice(0, 6)}••••${val.slice(-4)}`;
  }

  function formatResetTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function parseTimestamp(dateStr) {
    if (!dateStr) return 0;
    if (typeof dateStr === 'number') return dateStr > 1e12 ? dateStr : dateStr * 1000;
    let d = new Date(dateStr);
    if (Number.isNaN(d.getTime()) && typeof dateStr === 'string') {
      const normalized = dateStr.replace(' ', 'T').replace(/\s+([+-]\d{4})$/, '$1');
      d = new Date(normalized);
    }
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function formatDate(iso) {
    const ts = parseTimestamp(iso);
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatShortDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
  }

  function formatBranchHeaderLabel(branchName) {
    if (!state.shortHeaders) return branchName;
    const str = String(branchName || '');
    const lastSlash = str.lastIndexOf('/');
    if (lastSlash !== -1 && lastSlash < str.length - 1) {
      return str.slice(lastSlash + 1);
    }
    return str;
  }

  function encodeBranchPath(branchName) {
    return String(branchName || '')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  function buildCommitsPageUrl(owner, repo, branchName, cursor, filePath = '') {
    let base = `https://github.com/${owner}/${repo}/commits/${encodeBranchPath(branchName)}`;
    if (filePath) {
      base += `/${encodeBranchPath(filePath)}`;
    }
    if (!cursor) return base;
    const clean = String(cursor).trim();
    const parts = clean.split(/[+\s]+/);
    if (parts.length === 2 && /^[0-9a-f]{7,40}$/i.test(parts[0]) && /^\d+$/.test(parts[1])) {
      return `${base}?after=${parts[0]}+${parts[1]}`;
    }
    return `${base}?after=${encodeURIComponent(clean).replace(/%2B/gi, '+')}`;
  }

  function isSubsetSet(subset, superset) {
    if (!subset || !superset) return false;
    for (const item of subset) {
      if (!superset.has(item)) return false;
    }
    return true;
  }

  function isTokenCurrentlyExhausted(tok) {
    if (!tok) return false;
    if (tok.status !== 'exhausted' && tok.remaining !== 0) return false;
    if (tok.resetAt && Date.now() >= tok.resetAt) {
      tok.status = 'unknown';
      tok.remaining = null;
      return false;
    }
    return true;
  }

  function sanitizeMetaOrder(arr) {
    if (!Array.isArray(arr)) return [...CONSTANTS.DEFAULT_META_ORDER];
    const valid = arr.filter((k) => CONSTANTS.DEFAULT_META_ORDER.includes(k));
    const unique = Array.from(new Set(valid));
    for (const k of CONSTANTS.DEFAULT_META_ORDER) {
      if (!unique.includes(k)) unique.push(k);
    }
    return unique;
  }

  function parseGitHubRepo() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo] = parts;
    if (CONSTANTS.RESERVED_PATHS.has(owner.toLowerCase())) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  function extractPrNumberFromMessage(message) {
    const subject = String(message || '').split('\n')[0];
    let m = subject.match(/Merge pull request #(\d+)\b/i);
    if (m) return Number(m[1]);
    m = subject.match(/\(#(\d+)\)\s*$/);
    if (m) return Number(m[1]);
    return null;
  }

  function getBranchColor(index) {
    return CONSTANTS.MATRIX_PALETTE[Math.abs(index) % CONSTANTS.MATRIX_PALETTE.length];
  }

  function getBranchWidth(branchName) {
    const w = Number(state.columnWidths[branchName]);
    if (!Number.isNaN(w) && w >= CONSTANTS.MIN_BRANCH_COL_WIDTH && w <= CONSTANTS.MAX_BRANCH_COL_WIDTH) {
      return w;
    }
    return CONSTANTS.DEFAULT_BRANCH_COL_WIDTH;
  }

  function rebuildTagsBySha() {
    const map = new Map();
    for (const tag of state.tags) {
      if (!tag?.sha || !tag?.name) continue;
      const key = tag.sha.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(tag.name)) {
        map.get(key).push(tag.name);
      }
    }
    state.tagsBySha = map;
  }

  function getTagsForSha(sha) {
    if (!sha) return [];
    const lower = String(sha).toLowerCase();
    const exact = state.tagsBySha.get(lower);
    if (exact && exact.length > 0) return exact;
    const short7 = lower.slice(0, 7);
    const matched = [];
    for (const [k, names] of state.tagsBySha.entries()) {
      if (k.startsWith(short7) || lower.startsWith(k)) {
        for (const n of names) {
          if (!matched.includes(n)) matched.push(n);
        }
      }
    }
    return matched;
  }

  function resetNavigationAndSelection() {
    state.activeSha = null;
    state.selectedShas.clear();
    state.lastAnchorSha = null;
    state.navHistory = [];
    state.navIndex = -1;
  }

  function pushNavHistory(activeSha, shasArr) {
    const cleanShas = Array.from(new Set((shasArr || []).filter(Boolean)));
    if (!activeSha && cleanShas.length === 0) return;
    const key = `${activeSha || ''}::${[...cleanShas].sort().join(',')}`;

    const current = state.navIndex >= 0 ? state.navHistory[state.navIndex] : null;
    if (current && current.key === key) return;

    // Truncar futuro si estábamos navegando hacia atrás
    if (state.navIndex < state.navHistory.length - 1) {
      state.navHistory = state.navHistory.slice(0, state.navIndex + 1);
    }

    state.navHistory.push({
      key,
      activeSha: activeSha || cleanShas[0] || null,
      shas: cleanShas
    });

    if (state.navHistory.length > CONSTANTS.MAX_NAV_HISTORY) {
      state.navHistory.shift();
    }
    state.navIndex = state.navHistory.length - 1;
  }

  function compareBranchesBySort(a, b) {
    const mode = state.branchSort;
    if (mode === 'alpha_asc') {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (mode === 'alpha_desc') {
      return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (mode === 'date_desc') {
      const diff = (b.timestamp || 0) - (a.timestamp || 0);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    if (mode === 'date_asc') {
      const ta = a.timestamp || Number.MAX_SAFE_INTEGER;
      const tb = b.timestamp || Number.MAX_SAFE_INTEGER;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    }
    return a.name.localeCompare(b.name);
  }

  function getOrderedSelectedBranches() {
    const priority = ['main', 'master', 'develop', 'dev'];
    const branchByName = new Map(state.branches.map((b) => [b.name, b]));
    const selectedArr = Array.from(state.selectedBranches);

    const orderIdx = new Map();
    state.customColumnOrder.forEach((name, idx) => orderIdx.set(name, idx));

    const existingOrdered = [];
    const newlyAdded = [];

    for (const name of selectedArr) {
      if (orderIdx.has(name)) existingOrdered.push(name);
      else newlyAdded.push(name);
    }

    existingOrdered.sort((a, b) => orderIdx.get(a) - orderIdx.get(b));

    newlyAdded.sort((a, b) => {
      const ia = priority.indexOf(a.toLowerCase());
      const ib = priority.indexOf(b.toLowerCase());
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      const ba = branchByName.get(a) || { name: a, timestamp: 0 };
      const bb = branchByName.get(b) || { name: b, timestamp: 0 };
      return compareBranchesBySort(ba, bb);
    });

    const finalOrder = [...existingOrdered, ...newlyAdded];

    if (newlyAdded.length > 0) {
      const knownSet = new Set(state.customColumnOrder);
      newlyAdded.forEach((n) => {
        if (!knownSet.has(n)) state.customColumnOrder.push(n);
      });
    }

    return finalOrder;
  }

  function buildBranchTree(branches) {
    const root = { type: 'folder', name: '', fullPrefix: '', folders: new Map(), branches: [] };

    for (const branch of branches) {
      const parts = branch.name.split('/');
      let curr = root;
      let prefixAcc = '';

      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        prefixAcc = prefixAcc ? `${prefixAcc}/${seg}` : seg;
        if (!curr.folders.has(seg)) {
          curr.folders.set(seg, {
            type: 'folder',
            name: seg,
            fullPrefix: `${prefixAcc}/`,
            folders: new Map(),
            branches: []
          });
        }
        curr = curr.folders.get(seg);
      }

      curr.branches.push({ type: 'branch', leafName: parts[parts.length - 1], branch });
    }

    function finalizeNode(node) {
      const allDescendants = [];
      let maxTs = 0;
      let minTs = Number.MAX_SAFE_INTEGER;

      const folderList = Array.from(node.folders.values());
      for (const f of folderList) {
        finalizeNode(f);
        allDescendants.push(...f.allBranches);
        if (f.maxTs > maxTs) maxTs = f.maxTs;
        if (f.minTs < minTs) minTs = f.minTs;
      }

      node.branches.sort((a, b) => compareBranchesBySort(a.branch, b.branch));

      for (const item of node.branches) {
        allDescendants.push(item.branch);
        const ts = item.branch.timestamp || 0;
        if (ts > maxTs) maxTs = ts;
        if (ts > 0 && ts < minTs) minTs = ts;
      }

      folderList.sort((a, b) => {
        if (state.branchSort === 'alpha_asc') {
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (state.branchSort === 'alpha_desc') {
          return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (state.branchSort === 'date_desc') {
          const diff = (b.maxTs || 0) - (a.maxTs || 0);
          if (diff !== 0) return diff;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        }
        const diff = (a.minTs || Number.MAX_SAFE_INTEGER) - (b.minTs || Number.MAX_SAFE_INTEGER);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });

      node.sortedFolders = folderList;
      node.allBranches = allDescendants;
      node.maxTs = maxTs;
      node.minTs = minTs;
    }

    finalizeNode(root);
    return root;
  }

  // =====================================================================
  // PERSISTENCIA: TOKENS GLOBALES + CONFIGURACIÓN POR REPOSITORIO + CACHÉ
  // =====================================================================

  function loadGlobalTokens() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        ['mgg_github_tokens', 'mgg_active_token_idx', 'mgg_auto_rotate', 'mgg_github_token'],
        (res) => {
          let list = Array.isArray(res.mgg_github_tokens) ? res.mgg_github_tokens : [];

          if (list.length === 0 && res.mgg_github_token) {
            const clean = sanitizeToken(res.mgg_github_token);
            if (clean) {
              list = [
                {
                  id: `pat_${Date.now()}`,
                  label: 'PAT #1',
                  value: clean,
                  remaining: null,
                  limit: null,
                  resetAt: null,
                  status: 'unknown',
                  ssoUrl: null
                }
              ];
            }
          }

          state.tokens = list;
          state.activeTokenIndex =
            typeof res.mgg_active_token_idx === 'number' &&
            res.mgg_active_token_idx >= 0 &&
            res.mgg_active_token_idx < list.length
              ? res.mgg_active_token_idx
              : 0;
          state.autoRotate = res.mgg_auto_rotate !== false;
          saveGlobalTokens();
          resolve();
        }
      );
    });
  }

  function saveGlobalTokens() {
    chrome.storage.local.set({
      mgg_github_tokens: state.tokens,
      mgg_active_token_idx: state.activeTokenIndex,
      mgg_auto_rotate: state.autoRotate
    });
  }

  function resetStateToRepoDefaults() {
    state.hasSavedRepoConfig = false;
    state.connectionMode = 'auto';
    state.graphLayout = 'columns';
    state.arrowMode = 'all';
    state.branchSort = 'alpha_asc';
    state.shortHeaders = true;
    state.showTags = true;
    state.commitsPerBranch = 100;

    state.sidebarWidth = 280;
    state.tagsHeight = 155;
    state.tokenDrawerHeight = null;
    state.detailHeight = 290;
    state.detailLeftWidth = 350;
    state.detailMsgHeight = 72;
    state.explorerSidebarWidth = 300;
    state.diffViewMode = 'split';
    state.sourceTreeGraphWidth = null;
    state.customColumnOrder = [];
    state.columnWidths = {};
    state.metaColumnOrder = [...CONSTANTS.DEFAULT_META_ORDER];
    state.metaWidths = { ...CONSTANTS.DEFAULT_META_WIDTHS };
    state.selectedBranches = new Set();
    state.collapsedFolders = new Set();
    state.tagsCollapsed = false;
    state.branchFilter = '';
    resetNavigationAndSelection();
  }

  function loadRepoConfig(repoFullName) {
    return new Promise((resolve) => {
      resetStateToRepoDefaults();
      if (!repoFullName) {
        resolve();
        return;
      }

      chrome.storage.local.get(
        [CONSTANTS.REPO_CONFIGS_STORAGE_KEY, CONSTANTS.LEGACY_REPO_PREFS_KEY],
        (res) => {
          const allV2 = res?.[CONSTANTS.REPO_CONFIGS_STORAGE_KEY] || {};
          const cfg = allV2[repoFullName];

          if (cfg && typeof cfg === 'object') {
            state.hasSavedRepoConfig = true;
            if (['auto', 'web', 'api'].includes(cfg.connectionMode)) {
              state.connectionMode = cfg.connectionMode;
            }
            if (['columns', 'sourcetree'].includes(cfg.graphLayout)) {
              state.graphLayout = cfg.graphLayout;
            }
            if (['all', 'integrations', 'none'].includes(cfg.arrowMode)) {
              state.arrowMode = cfg.arrowMode;
            }
            if (['alpha_asc', 'alpha_desc', 'date_desc', 'date_asc'].includes(cfg.branchSort)) {
              state.branchSort = cfg.branchSort;
            }
            if (typeof cfg.shortHeaders === 'boolean') state.shortHeaders = cfg.shortHeaders;
            if (typeof cfg.showTags === 'boolean') state.showTags = cfg.showTags;
            if (typeof cfg.commitsPerBranch === 'number' && cfg.commitsPerBranch >= 25) {
              state.commitsPerBranch = cfg.commitsPerBranch;
            }
            if (typeof cfg.sidebarWidth === 'number' && cfg.sidebarWidth >= 180) {
              state.sidebarWidth = Math.min(820, cfg.sidebarWidth);
            }
            if (typeof cfg.tagsHeight === 'number' && cfg.tagsHeight >= 36) {
              state.tagsHeight = Math.min(600, cfg.tagsHeight);
            }
            if (typeof cfg.tokenDrawerHeight === 'number' && cfg.tokenDrawerHeight >= 110) {
              state.tokenDrawerHeight = Math.min(550, cfg.tokenDrawerHeight);
            }
            if (typeof cfg.detailHeight === 'number' && cfg.detailHeight >= 150) {
              state.detailHeight = Math.min(720, cfg.detailHeight);
            }
            if (typeof cfg.detailLeftWidth === 'number' && cfg.detailLeftWidth >= 180) {
              state.detailLeftWidth = Math.min(920, cfg.detailLeftWidth);
            }
            if (typeof cfg.detailMsgHeight === 'number' && cfg.detailMsgHeight >= 34) {
              state.detailMsgHeight = Math.min(400, cfg.detailMsgHeight);
            }
            if (typeof cfg.explorerSidebarWidth === 'number' && cfg.explorerSidebarWidth >= 180) {
              state.explorerSidebarWidth = Math.min(820, cfg.explorerSidebarWidth);
            }
            if (['split', 'unified'].includes(cfg.diffViewMode)) {
              state.diffViewMode = cfg.diffViewMode;
            }
            if (typeof cfg.sourceTreeGraphWidth === 'number' && cfg.sourceTreeGraphWidth >= 80) {
              state.sourceTreeGraphWidth = Math.min(600, cfg.sourceTreeGraphWidth);
            }
            if (Array.isArray(cfg.customColumnOrder)) {
              state.customColumnOrder = [...cfg.customColumnOrder];
            }
            if (cfg.columnWidths && typeof cfg.columnWidths === 'object') {
              state.columnWidths = { ...cfg.columnWidths };
            }
            state.metaColumnOrder = sanitizeMetaOrder(cfg.metaColumnOrder);
            if (cfg.metaWidths && typeof cfg.metaWidths === 'object') {
              state.metaWidths = {
                msg:
                  typeof cfg.metaWidths.msg === 'number' && cfg.metaWidths.msg >= 140
                    ? cfg.metaWidths.msg
                    : null,
                sha: Number(cfg.metaWidths.sha) || CONSTANTS.DEFAULT_META_WIDTHS.sha,
                author: Number(cfg.metaWidths.author) || CONSTANTS.DEFAULT_META_WIDTHS.author,
                date: Number(cfg.metaWidths.date) || CONSTANTS.DEFAULT_META_WIDTHS.date
              };
            }
            if (Array.isArray(cfg.selectedBranches)) {
              state.selectedBranches = new Set(cfg.selectedBranches);
            }
            if (Array.isArray(cfg.collapsedFolders)) {
              state.collapsedFolders = new Set(cfg.collapsedFolders);
            }
            if (typeof cfg.tagsCollapsed === 'boolean') {
              state.tagsCollapsed = cfg.tagsCollapsed;
            }
          } else {
            const legacyAll = res?.[CONSTANTS.LEGACY_REPO_PREFS_KEY] || {};
            const legacy = legacyAll[repoFullName];
            if (legacy && typeof legacy === 'object') {
              if (Array.isArray(legacy.columnOrder)) state.customColumnOrder = [...legacy.columnOrder];
              if (legacy.columnWidths && typeof legacy.columnWidths === 'object') {
                state.columnWidths = { ...legacy.columnWidths };
              }
            }
          }

          resolve();
        }
      );
    });
  }

  function saveCurrentRepoConfig() {
    if (!state.repo?.fullName) return;
    const repoKey = state.repo.fullName;
    state.hasSavedRepoConfig = true;

    const payload = {
      connectionMode: state.connectionMode,
      graphLayout: state.graphLayout,
      arrowMode: state.arrowMode,
      branchSort: state.branchSort,
      shortHeaders: state.shortHeaders,
      showTags: state.showTags,
      commitsPerBranch: state.commitsPerBranch,
      sidebarWidth: state.sidebarWidth,
      tagsHeight: state.tagsHeight,
      tokenDrawerHeight: state.tokenDrawerHeight,
      detailHeight: state.detailHeight,
      detailLeftWidth: state.detailLeftWidth,
      detailMsgHeight: state.detailMsgHeight,
      explorerSidebarWidth: state.explorerSidebarWidth,
      diffViewMode: state.diffViewMode,
      sourceTreeGraphWidth: state.sourceTreeGraphWidth,
      customColumnOrder: [...state.customColumnOrder],
      columnWidths: { ...state.columnWidths },
      metaColumnOrder: [...state.metaColumnOrder],
      metaWidths: { ...state.metaWidths },
      selectedBranches: Array.from(state.selectedBranches),
      collapsedFolders: Array.from(state.collapsedFolders),
      tagsCollapsed: state.tagsCollapsed,
      updatedAt: Date.now()
    };

    chrome.storage.local.get([CONSTANTS.REPO_CONFIGS_STORAGE_KEY], (res) => {
      const all = res?.[CONSTANTS.REPO_CONFIGS_STORAGE_KEY] || {};
      all[repoKey] = payload;
      chrome.storage.local.set({ [CONSTANTS.REPO_CONFIGS_STORAGE_KEY]: all });
    });
  }

  function loadRepoParentsCache(repoFullName) {
    return new Promise((resolve) => {
      chrome.storage.local.get([CONSTANTS.PARENT_CACHE_STORAGE_KEY], (res) => {
        const all = res?.[CONSTANTS.PARENT_CACHE_STORAGE_KEY] || {};
        const repoObj = all[repoFullName] || {};
        const map = new Map();
        for (const [sha, parents] of Object.entries(repoObj)) {
          if (Array.isArray(parents)) map.set(sha, parents);
        }
        state.parentsCache = map;
        resolve(map);
      });
    });
  }

  function saveRepoParentsCache(repoFullName) {
    if (!repoFullName) return;
    chrome.storage.local.get([CONSTANTS.PARENT_CACHE_STORAGE_KEY], (res) => {
      const all = res?.[CONSTANTS.PARENT_CACHE_STORAGE_KEY] || {};
      const entries = Array.from(state.parentsCache.entries());
      const trimmed =
        entries.length > CONSTANTS.MAX_CACHED_SHAS_PER_REPO
          ? entries.slice(entries.length - CONSTANTS.MAX_CACHED_SHAS_PER_REPO)
          : entries;
      const repoObj = {};
      for (const [sha, parents] of trimmed) repoObj[sha] = parents;
      all[repoFullName] = repoObj;
      chrome.storage.local.set({ [CONSTANTS.PARENT_CACHE_STORAGE_KEY]: all });
    });
  }

  window.MGG = Object.assign(window.MGG || {}, {
    CONSTANTS,
    state,
    ui,
    callbacks,
    escapeHtml,
    escapeRegExp,
    sanitizeToken,
    maskToken,
    formatResetTime,
    parseTimestamp,
    formatDate,
    formatShortDate,
    formatBranchHeaderLabel,
    encodeBranchPath,
    buildCommitsPageUrl,
    isSubsetSet,
    isTokenCurrentlyExhausted,
    sanitizeMetaOrder,
    parseGitHubRepo,
    extractPrNumberFromMessage,
    getBranchColor,
    getBranchWidth,
    rebuildTagsBySha,
    getTagsForSha,
    resetNavigationAndSelection,
    pushNavHistory,
    compareBranchesBySort,
    getOrderedSelectedBranches,
    buildBranchTree,
    loadGlobalTokens,
    saveGlobalTokens,
    resetStateToRepoDefaults,
    loadRepoConfig,
    saveCurrentRepoConfig,
    loadRepoParentsCache,
    saveRepoParentsCache
  });
})();