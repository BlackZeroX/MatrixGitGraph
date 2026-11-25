(() => {
  if (window.__MATRIX_GIT_GRAPH_INIT__) return;
  window.__MATRIX_GIT_GRAPH_INIT__ = true;

  const MGG = window.MGG;
  const { CONSTANTS, state, ui, callbacks } = MGG;

  let draggedBranchName = null;
  let draggedMetaKey = null;

  // Estado local del panel de detalle inline (1 o varios commits)
  const detailState = {
    selectionKey: null,
    commits: [],
    files: [], // [{ filename, previousFilename, status, additions, deletions, blobUrl, entries: [{ commit, file }] }]
    selectedFileIdx: 0,
    fileFilter: ''
  };

  // =====================================================================
  // INTERFAZ PRINCIPAL (100% PANTALLA + NAVEGACIÓN + PANELES REDIMENSIONABLES)
  // =====================================================================

  function ensureUI() {
    if (!ui.stickyBtn) {
      ui.stickyBtn = document.createElement('button');
      ui.stickyBtn.id = 'mgg-sticky-btn';
      ui.stickyBtn.type = 'button';
      ui.stickyBtn.innerHTML = '<span>>_</span><span>MATRIX GIT GRAPH</span>';
      ui.stickyBtn.addEventListener('click', openModal);
      document.body.appendChild(ui.stickyBtn);
    }

    if (!ui.overlay) {
      ui.overlay = document.createElement('div');
      ui.overlay.id = 'mgg-overlay';
      ui.overlay.innerHTML = `
        <div id="mgg-modal" role="dialog" aria-modal="true" aria-label="Matrix Git Graph">
          <div class="mgg-header">
            <div class="mgg-title">
              <span>>_ MATRIX // GIT GRAPH v2.3</span>
              <span class="mgg-repo-badge" id="mgg-repo-label"></span>
              <span style="font-size:10.5px; color:#55bd6d; font-weight:400;">by Ortega Avila, Miguel Angel</span>
            </div>
            <div class="mgg-controls">
              <label class="mgg-toggle-label" title="Oculta prefijos como feature/ en los encabezados de columna">
                <input type="checkbox" id="mgg-short-headers-chk" checked />
                <span>Headers cortos</span>
              </label>
              <label class="mgg-toggle-label" title="Muestra u oculta las etiquetas de Tags sobre los commits">
                <input type="checkbox" id="mgg-show-tags-chk" checked />
                <span>Tags</span>
              </label>
              <select id="mgg-arrows-select" class="mgg-select" title="Flechas del flujo de integraciones">
                <option value="all">Flechas: Todas</option>
                <option value="integrations">Flechas: Integraciones</option>
                <option value="none">Flechas: Ocultas</option>
              </select>
              <select id="mgg-layout-select" class="mgg-select" title="Estilo del grafo">
                <option value="columns">Vista: Columnas</option>
                <option value="sourcetree">Vista: SourceTree</option>
              </select>
              <select id="mgg-mode-select" class="mgg-select" title="Modo de conexión">
                <option value="auto">Modo: AUTO (SAML)</option>
                <option value="web">Modo: Sesión Web (SAML)</option>
                <option value="api">Modo: Solo API (PATs)</option>
              </select>
              <select id="mgg-limit-select" class="mgg-select" title="Commits por rama">
                <option value="50">50 commits/rama</option>
                <option value="100" selected>100 commits/rama</option>
                <option value="200">200 commits/rama</option>
                <option value="500">500 commits/rama</option>
              </select>
              <button type="button" id="mgg-load-more-btn" class="mgg-btn" title="Aumentar profundidad de commits">+50</button>
              <button type="button" id="mgg-create-pr-header-btn" class="mgg-btn mgg-btn-cyan" title="Crear un nuevo Pull Request entre ramas">🔀 Crear PR</button>
              <button type="button" id="mgg-tokens-toggle" class="mgg-btn">🔑 PATs (0)</button>
              <button type="button" id="mgg-refresh-btn" class="mgg-btn">↻ Recargar</button>
              <button type="button" id="mgg-close-btn" class="mgg-btn mgg-btn-close">✕ Cerrar</button>
            </div>
          </div>

          <div id="mgg-token-drawer" class="mgg-token-drawer">
            <div class="mgg-token-drawer-top">
              <span class="mgg-token-drawer-title">POOL DE TOKENS GITHUB (PAT) + SOPORTE SAML SSO</span>
              <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
                <label class="mgg-toggle-label">
                  <input type="checkbox" id="mgg-auto-rotate-chk" checked />
                  <span>Auto-rotar al agotar API (403/429) o error SAML</span>
                </label>
                <button type="button" id="mgg-check-limits-btn" class="mgg-btn mgg-btn-sm">⚡ Verificar cuotas</button>
                <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm mgg-btn-sso">Configurar SSO en GitHub ↗</a>
              </div>
            </div>

            <div class="mgg-token-form">
              <input
                type="text"
                id="mgg-new-token-alias"
                class="mgg-input"
                placeholder="Alias (ej. Personal, Trabajo)"
                style="width: 190px;"
              />
              <input
                type="password"
                id="mgg-new-token-value"
                class="mgg-input"
                placeholder="Pega aquí tu GitHub PAT (ghp_... / github_pat_...)"
                style="flex: 1; min-width: 260px;"
              />
              <button type="button" id="mgg-add-token-btn" class="mgg-btn">+ Agregar PAT</button>
            </div>

            <div id="mgg-token-list" class="mgg-token-list"></div>
            <div class="mgg-drawer-resizer" id="mgg-drawer-resizer" title="Arrastra para redimensionar panel de PATs (doble clic restablece)"></div>
          </div>

          <div class="mgg-body">
            <aside class="mgg-sidebar" id="mgg-sidebar">
              <div class="mgg-sidebar-resizer" id="mgg-sidebar-resizer" title="Arrastra para redimensionar panel izquierdo (doble clic restablece)"></div>
              <div class="mgg-sidebar-title">
                <span>RAMAS (TREE)</span>
                <span id="mgg-branch-count">0/0</span>
              </div>

              <div class="mgg-sidebar-row">
                <select id="mgg-branch-sort" class="mgg-select" style="flex:1;" title="Ordenar ramas">
                  <option value="alpha_asc">Orden: Alfabético (A → Z)</option>
                  <option value="alpha_desc">Orden: Alfabético (Z → A)</option>
                  <option value="date_desc">Orden: Fecha (Recientes ↓)</option>
                  <option value="date_asc">Orden: Fecha (Antiguas ↑)</option>
                </select>
              </div>

              <input
                type="text"
                id="mgg-branch-search"
                class="mgg-input"
                placeholder="Filtrar ramas y tags..."
              />

              <div class="mgg-sidebar-row">
                <input
                  type="text"
                  id="mgg-prefix-input"
                  class="mgg-input"
                  placeholder="Ante-texto (ej. feature)"
                  style="flex:1; min-width:0;"
                />
                <button type="button" id="mgg-prefix-add" class="mgg-btn mgg-btn-sm" title="Agregar todas las ramas con este prefijo">+Col</button>
                <button type="button" id="mgg-prefix-del" class="mgg-btn mgg-btn-sm mgg-btn-close" title="Quitar ramas con este prefijo">-Col</button>
              </div>

              <div id="mgg-prefix-chips" class="mgg-prefix-chips"></div>

              <div class="mgg-quick-actions">
                <button type="button" id="mgg-sel-all" class="mgg-btn">Todas</button>
                <button type="button" id="mgg-sel-none" class="mgg-btn">Ninguna</button>
                <button type="button" id="mgg-reset-cols" class="mgg-btn" title="Restablecer orden y anchos de columnas de este repo">↺ Cols</button>
              </div>

              <div id="mgg-branch-list" class="mgg-branch-list"></div>

              <div class="mgg-tags-section" id="mgg-tags-section">
                <div class="mgg-tags-resizer" id="mgg-tags-resizer" title="Arrastra para redimensionar sección de Tags (doble clic restablece)"></div>
                <div class="mgg-tags-header" id="mgg-tags-header" title="Clic para expandir o colapsar Tags">
                  <span id="mgg-tags-title">▾ 🏷 TAGS (0)</span>
                </div>
                <div class="mgg-tags-list" id="mgg-tags-list"></div>
              </div>
            </aside>

            <section class="mgg-main">
              <div class="mgg-status-bar">
                <div class="mgg-status-left">
                  <div class="mgg-nav-bar" title="Navegación de commits (Ctrl+Clic / Shift+Clic para selección múltiple)">
                    <button type="button" id="mgg-nav-home" class="mgg-nav-btn" title="Ir al inicio de la navegación (o al tope del grafo)">⌂</button>
                    <button type="button" id="mgg-nav-back" class="mgg-nav-btn" title="Atrás en el historial de commits" disabled>◀</button>
                    <button type="button" id="mgg-nav-fwd" class="mgg-nav-btn" title="Adelante en el historial de commits" disabled>▶</button>
                    <span id="mgg-nav-counter" class="mgg-nav-counter">0/0</span>
                    <button type="button" id="mgg-nav-clear" class="mgg-nav-btn mgg-nav-clear" title="Limpiar navegación y selección" disabled>✕</button>
                  </div>
                  <span id="mgg-status-text">Listo</span>
                </div>
                <span id="mgg-rate-text"></span>
              </div>
              <div id="mgg-graph-scroll" class="mgg-graph-scroll"></div>
              <div id="mgg-detail-panel" class="mgg-detail-panel"></div>
            </section>
          </div>
        </div>
      `;

      document.body.appendChild(ui.overlay);
      MGG.explorer.mount(ui.overlay.querySelector('#mgg-modal'));
      bindModalEvents();
    }
  }

  function syncLimitSelectUI() {
    const sel = ui.overlay?.querySelector('#mgg-limit-select');
    if (!sel) return;
    const valStr = String(state.commitsPerBranch);
    if (!Array.from(sel.options).some((o) => o.value === valStr)) {
      const opt = document.createElement('option');
      opt.value = valStr;
      opt.textContent = `${valStr} commits/rama`;
      sel.appendChild(opt);
    }
    sel.value = valStr;
  }

  // =====================================================================
  // NAVEGACIÓN (INICIO / ATRÁS / ADELANTE / LIMPIAR) Y SELECCIÓN MÚLTIPLE
  // =====================================================================

  function updateNavBarUI() {
    if (!ui.overlay) return;
    const homeBtn = ui.overlay.querySelector('#mgg-nav-home');
    const backBtn = ui.overlay.querySelector('#mgg-nav-back');
    const fwdBtn = ui.overlay.querySelector('#mgg-nav-fwd');
    const clearBtn = ui.overlay.querySelector('#mgg-nav-clear');
    const counterEl = ui.overlay.querySelector('#mgg-nav-counter');

    const total = state.navHistory.length;
    const idx = state.navIndex;

    if (counterEl) counterEl.textContent = total > 0 && idx >= 0 ? `${idx + 1}/${total}` : '0/0';
    if (backBtn) backBtn.disabled = idx <= 0;
    if (fwdBtn) fwdBtn.disabled = idx < 0 || idx >= total - 1;
    if (homeBtn) homeBtn.disabled = total === 0 && state.orderedCommits.length === 0;
    if (clearBtn) clearBtn.disabled = total === 0 && state.selectedShas.size === 0 && !state.activeSha;
  }

  function syncRowSelectionClasses() {
    const graphScroll = ui.overlay?.querySelector('#mgg-graph-scroll');
    if (!graphScroll) return;

    graphScroll.querySelectorAll('.mgg-commit-row').forEach((row) => {
      const sha = row.getAttribute('data-sha');
      row.classList.toggle('mgg-row-active', sha === state.activeSha);
      row.classList.toggle('mgg-row-multi', state.selectedShas.has(sha));
    });
  }

  function applySelection(shasArr, activeSha, { pushHistory = true, scrollIntoView = false } = {}) {
    const validShas = (shasArr || []).filter((s) => state.commitMap.has(s));
    state.selectedShas = new Set(validShas);

    if (validShas.length === 0) {
      state.activeSha = null;
      syncRowSelectionClasses();
      ui.overlay?.querySelector('#mgg-detail-panel')?.classList.remove('mgg-visible');
      updateNavBarUI();
      return;
    }

    const resolvedActive =
      activeSha && state.selectedShas.has(activeSha) ? activeSha : validShas[0];
    state.activeSha = resolvedActive;

    if (pushHistory) {
      MGG.pushNavHistory(resolvedActive, validShas);
    }

    syncRowSelectionClasses();
    updateNavBarUI();

    if (scrollIntoView && resolvedActive) {
      const graphScroll = ui.overlay?.querySelector('#mgg-graph-scroll');
      const row = graphScroll?.querySelector(`.mgg-commit-row[data-sha="${resolvedActive}"]`);
      if (row) {
        row.classList.remove('mgg-row-flash');
        void row.offsetWidth;
        row.classList.add('mgg-row-flash');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    showSelectionDetails();
  }

  function navigateToHistoryIndex(targetIdx) {
    if (targetIdx < 0 || targetIdx >= state.navHistory.length) return;
    state.navIndex = targetIdx;
    const entry = state.navHistory[targetIdx];
    state.lastAnchorSha = entry.activeSha;
    applySelection(entry.shas, entry.activeSha, { pushHistory: false, scrollIntoView: true });
  }

  function navigateHome() {
    if (state.navHistory.length > 0) {
      navigateToHistoryIndex(0);
    } else if (state.orderedCommits.length > 0) {
      const firstSha = state.orderedCommits[0].sha;
      state.lastAnchorSha = firstSha;
      applySelection([firstSha], firstSha, { pushHistory: true, scrollIntoView: true });
    }
  }

  function clearNavigationAndSelection() {
    MGG.resetNavigationAndSelection();
    detailState.selectionKey = null;
    detailState.commits = [];
    detailState.files = [];
    syncRowSelectionClasses();
    ui.overlay?.querySelector('#mgg-detail-panel')?.classList.remove('mgg-visible');
    updateNavBarUI();
    setStatus('Navegación y selección limpiadas.');
  }

  function handleCommitRowClick(e, sha) {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    if (isShift && (state.lastAnchorSha || state.activeSha)) {
      const anchor = state.lastAnchorSha || state.activeSha;
      const idxA = state.orderedCommits.findIndex((c) => c.sha === anchor);
      const idxB = state.orderedCommits.findIndex((c) => c.sha === sha);
      if (idxA !== -1 && idxB !== -1) {
        const start = Math.min(idxA, idxB);
        const end = Math.max(idxA, idxB);
        const rangeShas = state.orderedCommits.slice(start, end + 1).map((c) => c.sha);
        const nextSet = isCtrl ? new Set([...state.selectedShas, ...rangeShas]) : new Set(rangeShas);
        applySelection(Array.from(nextSet), sha, { pushHistory: true });
        return;
      }
    }

    if (isCtrl) {
      const nextSet = new Set(state.selectedShas);
      if (nextSet.has(sha)) {
        nextSet.delete(sha);
      } else {
        nextSet.add(sha);
      }
      state.lastAnchorSha = sha;
      const nextArr = Array.from(nextSet);
      const nextActive = nextSet.has(sha) ? sha : nextArr[nextArr.length - 1] || null;
      applySelection(nextArr, nextActive, { pushHistory: true });
      return;
    }

    // Clic simple
    state.lastAnchorSha = sha;
    applySelection([sha], sha, { pushHistory: true });
  }

  // =====================================================================
  // REDIMENSIONAMIENTO DE PANELES (SIDEBAR, TAGS, DRAWER PATS)
  // =====================================================================

  function bindPanelResizers() {
    const sidebar = ui.overlay.querySelector('#mgg-sidebar');
    const sidebarHandle = ui.overlay.querySelector('#mgg-sidebar-resizer');
    if (sidebar && sidebarHandle) {
      sidebar.style.width = `${state.sidebarWidth}px`;
      sidebarHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = sidebar.getBoundingClientRect().width;
        sidebarHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select');

        const onMove = (ev) => {
          const maxW = Math.round(window.innerWidth * 0.55);
          const nextW = Math.min(maxW, Math.max(180, Math.round(startW + (ev.clientX - startX))));
          state.sidebarWidth = nextW;
          sidebar.style.width = `${nextW}px`;
        };
        const onUp = () => {
          sidebarHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      sidebarHandle.addEventListener('dblclick', () => {
        state.sidebarWidth = 280;
        sidebar.style.width = '280px';
        MGG.saveCurrentRepoConfig();
      });
    }

    const tagsSection = ui.overlay.querySelector('#mgg-tags-section');
    const tagsHandle = ui.overlay.querySelector('#mgg-tags-resizer');
    if (tagsSection && tagsHandle) {
      tagsSection.style.height = `${state.tagsHeight}px`;
      tagsHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.tagsCollapsed) return;
        const startY = e.clientY;
        const startH = tagsSection.getBoundingClientRect().height;
        tagsHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select-row');

        const onMove = (ev) => {
          const maxH = Math.round(window.innerHeight * 0.6);
          const nextH = Math.min(maxH, Math.max(60, Math.round(startH - (ev.clientY - startY))));
          state.tagsHeight = nextH;
          tagsSection.style.height = `${nextH}px`;
        };
        const onUp = () => {
          tagsHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select-row');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      tagsHandle.addEventListener('dblclick', () => {
        state.tagsHeight = 155;
        tagsSection.style.height = '155px';
        MGG.saveCurrentRepoConfig();
      });
    }

    const drawer = ui.overlay.querySelector('#mgg-token-drawer');
    const drawerHandle = ui.overlay.querySelector('#mgg-drawer-resizer');
    if (drawer && drawerHandle) {
      if (state.tokenDrawerHeight) drawer.style.height = `${state.tokenDrawerHeight}px`;
      drawerHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = drawer.getBoundingClientRect().height;
        drawerHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select-row');

        const onMove = (ev) => {
          const maxH = Math.round(window.innerHeight * 0.55);
          const nextH = Math.min(maxH, Math.max(110, Math.round(startH + (ev.clientY - startY))));
          state.tokenDrawerHeight = nextH;
          drawer.style.height = `${nextH}px`;
        };
        const onUp = () => {
          drawerHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select-row');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      drawerHandle.addEventListener('dblclick', () => {
        state.tokenDrawerHeight = null;
        drawer.style.height = '';
        MGG.saveCurrentRepoConfig();
      });
    }
  }

  function bindModalEvents() {
    ui.overlay.addEventListener('click', (e) => {
      if (e.target === ui.overlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (MGG.explorer.isContextMenuOpen()) {
          MGG.explorer.closeContextMenu();
        } else if (MGG.explorer.isDialogOpen()) {
          MGG.explorer.closeDialog();
        } else if (MGG.explorer.isOpen()) {
          MGG.explorer.close();
        } else if (ui.overlay && ui.overlay.classList.contains('mgg-open')) {
          closeModal();
        }
        return;
      }

      if (
        ui.overlay &&
        ui.overlay.classList.contains('mgg-open') &&
        !MGG.explorer.isOpen() &&
        !MGG.explorer.isDialogOpen()
      ) {
        if (e.altKey && e.key === 'ArrowLeft') {
          e.preventDefault();
          navigateToHistoryIndex(state.navIndex - 1);
        } else if (e.altKey && e.key === 'ArrowRight') {
          e.preventDefault();
          navigateToHistoryIndex(state.navIndex + 1);
        }
      }
    });

    ui.overlay.querySelector('#mgg-nav-home').addEventListener('click', navigateHome);
    ui.overlay.querySelector('#mgg-nav-back').addEventListener('click', () => {
      navigateToHistoryIndex(state.navIndex - 1);
    });
    ui.overlay.querySelector('#mgg-nav-fwd').addEventListener('click', () => {
      navigateToHistoryIndex(state.navIndex + 1);
    });
    ui.overlay.querySelector('#mgg-nav-clear').addEventListener('click', clearNavigationAndSelection);

    ui.overlay.querySelector('#mgg-close-btn').addEventListener('click', closeModal);

    ui.overlay.querySelector('#mgg-create-pr-header-btn').addEventListener('click', () => {
      const activeCommit = state.activeSha ? state.commitMap.get(state.activeSha) : null;
      const suggestedHead =
        activeCommit?.headBranches?.[0] ||
        (activeCommit && Array.from(activeCommit.branches || [])[0]) ||
        '';
      MGG.explorer.openCreatePrDialog({ head: suggestedHead });
    });

    ui.overlay.querySelector('#mgg-short-headers-chk').addEventListener('change', (e) => {
      state.shortHeaders = e.target.checked;
      MGG.saveCurrentRepoConfig();
      renderGraph();
    });

    ui.overlay.querySelector('#mgg-show-tags-chk').addEventListener('change', (e) => {
      state.showTags = e.target.checked;
      MGG.saveCurrentRepoConfig();
      renderGraph();
    });

    ui.overlay.querySelector('#mgg-arrows-select').addEventListener('change', (e) => {
      state.arrowMode = e.target.value;
      MGG.saveCurrentRepoConfig();
      renderGraph();
    });

    ui.overlay.querySelector('#mgg-layout-select').addEventListener('change', (e) => {
      state.graphLayout = e.target.value;
      MGG.saveCurrentRepoConfig();
      renderGraph();
    });

    ui.overlay.querySelector('#mgg-mode-select').addEventListener('change', (e) => {
      state.connectionMode = e.target.value;
      MGG.saveCurrentRepoConfig();
      updateRateDisplay();
      loadRepoData();
    });

    ui.overlay.querySelector('#mgg-branch-sort').addEventListener('change', (e) => {
      state.branchSort = e.target.value;
      MGG.saveCurrentRepoConfig();
      renderBranchSidebar();
      if (state.branchSort.startsWith('date_')) MGG.github.hydrateMissingBranchDatesIfNeeded();
    });

    ui.overlay.querySelector('#mgg-tokens-toggle').addEventListener('click', () => {
      ui.overlay.querySelector('#mgg-token-drawer').classList.toggle('mgg-open');
      renderTokenList();
    });

    ui.overlay.querySelector('#mgg-auto-rotate-chk').addEventListener('change', (e) => {
      state.autoRotate = e.target.checked;
      MGG.saveGlobalTokens();
    });

    ui.overlay
      .querySelector('#mgg-check-limits-btn')
      .addEventListener('click', MGG.github.checkAllTokensRateLimit);
    ui.overlay.querySelector('#mgg-add-token-btn').addEventListener('click', addNewToken);
    ui.overlay.querySelector('#mgg-new-token-value').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addNewToken();
    });

    ui.overlay.querySelector('#mgg-refresh-btn').addEventListener('click', () => {
      state.explorer.commitDiffCache.clear();
      state.explorer.fileHistoryCache.clear();
      loadRepoData();
    });

    ui.overlay.querySelector('#mgg-limit-select').addEventListener('change', (e) => {
      state.commitsPerBranch = Number(e.target.value) || 100;
      MGG.saveCurrentRepoConfig();
      loadSelectedBranchesCommits();
    });

    ui.overlay.querySelector('#mgg-load-more-btn').addEventListener('click', () => {
      if (state.isLoading) return;
      state.commitsPerBranch = Math.min(2000, state.commitsPerBranch + 50);
      syncLimitSelectUI();
      MGG.saveCurrentRepoConfig();
      loadSelectedBranchesCommits();
    });

    ui.overlay.querySelector('#mgg-branch-search').addEventListener('input', (e) => {
      state.branchFilter = e.target.value.toLowerCase();
      renderBranchSidebar();
    });

    const prefixInput = ui.overlay.querySelector('#mgg-prefix-input');
    ui.overlay.querySelector('#mgg-prefix-add').addEventListener('click', () => {
      applyPrefixAction(prefixInput.value, true);
    });
    ui.overlay.querySelector('#mgg-prefix-del').addEventListener('click', () => {
      applyPrefixAction(prefixInput.value, false);
    });
    prefixInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyPrefixAction(prefixInput.value, true);
    });

    ui.overlay.querySelector('#mgg-sel-all').addEventListener('click', () => {
      const visible = state.branches.filter((b) =>
        b.name.toLowerCase().includes(state.branchFilter)
      );
      visible.forEach((b) => state.selectedBranches.add(b.name));
      MGG.saveCurrentRepoConfig();
      renderBranchSidebar();
      loadSelectedBranchesCommits();
    });

    ui.overlay.querySelector('#mgg-sel-none').addEventListener('click', () => {
      state.selectedBranches.clear();
      MGG.saveCurrentRepoConfig();
      renderBranchSidebar();
      renderGraph();
    });

    ui.overlay.querySelector('#mgg-reset-cols').addEventListener('click', () => {
      state.customColumnOrder = [];
      state.columnWidths = {};
      state.metaColumnOrder = [...CONSTANTS.DEFAULT_META_ORDER];
      state.metaWidths = { ...CONSTANTS.DEFAULT_META_WIDTHS };
      state.sourceTreeGraphWidth = null;
      MGG.saveCurrentRepoConfig();
      recomputeColumnsAndRender();
      setStatus('Orden y anchos de columnas restablecidos para este repositorio.');
    });

    ui.overlay.querySelector('#mgg-tags-header').addEventListener('click', () => {
      state.tagsCollapsed = !state.tagsCollapsed;
      MGG.saveCurrentRepoConfig();
      renderTagsSidebar();
    });

    bindPanelResizers();
  }

  function applyPrefixAction(rawPrefix, shouldAdd) {
    const clean = String(rawPrefix || '').trim().toLowerCase();
    if (!clean) {
      setStatus('Escribe un prefijo o ante-texto (ej. feature, CHG, release).');
      return;
    }

    const matching = state.branches.filter((b) => {
      const lower = b.name.toLowerCase();
      return lower.startsWith(clean) || lower.startsWith(`${clean}/`);
    });

    if (matching.length === 0) {
      setStatus(`No se encontraron ramas con el ante-texto "${rawPrefix}".`);
      return;
    }

    matching.forEach((b) => {
      if (shouldAdd) state.selectedBranches.add(b.name);
      else state.selectedBranches.delete(b.name);
    });

    MGG.saveCurrentRepoConfig();
    renderBranchSidebar();
    loadSelectedBranchesCommits();
    setStatus(
      `${shouldAdd ? 'Agregadas' : 'Quitadas'} ${matching.length} rama(s) con prefijo "${rawPrefix}".`
    );
  }

  function addNewToken() {
    const aliasInput = ui.overlay.querySelector('#mgg-new-token-alias');
    const valueInput = ui.overlay.querySelector('#mgg-new-token-value');
    const cleanVal = MGG.sanitizeToken(valueInput.value);

    if (!cleanVal) {
      setStatus('Pega un token válido antes de agregar.');
      return;
    }

    if (state.tokens.some((t) => t.value === cleanVal)) {
      setStatus('Ese PAT ya se encuentra en tu lista.');
      return;
    }

    const label = aliasInput.value.trim() || `PAT #${state.tokens.length + 1}`;
    state.tokens.push({
      id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      label,
      value: cleanVal,
      remaining: null,
      limit: null,
      resetAt: null,
      status: 'unknown',
      ssoUrl: null
    });

    const curr = state.tokens[state.activeTokenIndex];
    if (
      state.tokens.length === 1 ||
      !curr ||
      curr.status === 'exhausted' ||
      curr.status === 'invalid' ||
      curr.status === 'saml'
    ) {
      state.activeTokenIndex = state.tokens.length - 1;
    }

    aliasInput.value = '';
    valueInput.value = '';

    MGG.saveGlobalTokens();
    updateControlsUI();
    setStatus(`PAT "${label}" agregado. Recargando datos...`);
    loadRepoData();
  }

  function updateControlsUI() {
    if (!ui.overlay) return;
    const toggleBtn = ui.overlay.querySelector('#mgg-tokens-toggle');
    if (toggleBtn) toggleBtn.textContent = `🔑 PATs (${state.tokens.length})`;
    const rotateChk = ui.overlay.querySelector('#mgg-auto-rotate-chk');
    if (rotateChk) rotateChk.checked = state.autoRotate;
    const modeSelect = ui.overlay.querySelector('#mgg-mode-select');
    if (modeSelect) modeSelect.value = state.connectionMode;
    const layoutSelect = ui.overlay.querySelector('#mgg-layout-select');
    if (layoutSelect) layoutSelect.value = state.graphLayout;
    const arrowSelect = ui.overlay.querySelector('#mgg-arrows-select');
    if (arrowSelect) arrowSelect.value = state.arrowMode;
    const sortSelect = ui.overlay.querySelector('#mgg-branch-sort');
    if (sortSelect) sortSelect.value = state.branchSort;
    const shortChk = ui.overlay.querySelector('#mgg-short-headers-chk');
    if (shortChk) shortChk.checked = state.shortHeaders;
    const tagsChk = ui.overlay.querySelector('#mgg-show-tags-chk');
    if (tagsChk) tagsChk.checked = state.showTags;
    const sidebar = ui.overlay.querySelector('#mgg-sidebar');
    if (sidebar) sidebar.style.width = `${state.sidebarWidth}px`;
    const tagsSection = ui.overlay.querySelector('#mgg-tags-section');
    if (tagsSection) tagsSection.style.height = `${state.tagsHeight}px`;
    const drawer = ui.overlay.querySelector('#mgg-token-drawer');
    if (drawer) drawer.style.height = state.tokenDrawerHeight ? `${state.tokenDrawerHeight}px` : '';
    const searchInput = ui.overlay.querySelector('#mgg-branch-search');
    if (searchInput && searchInput.value !== state.branchFilter) {
      searchInput.value = state.branchFilter;
    }
    syncLimitSelectUI();
    updateRateDisplay();
    updateNavBarUI();
    renderTokenList();
  }

  function renderTokenList() {
    const listEl = ui.overlay?.querySelector('#mgg-token-list');
    if (!listEl) return;

    if (state.tokens.length === 0) {
      listEl.innerHTML =
        '<div style="font-size:11.5px; color:#55bd6d; padding:4px 2px;">Sin PATs guardados. En repos con SAML SSO puedes usar directamente <strong>Modo: Sesión Web (SAML)</strong>.</div>';
      return;
    }

    listEl.innerHTML = state.tokens
      .map((tok, idx) => {
        const isActive = idx === state.activeTokenIndex;
        let badgeClass = 'mgg-badge-ok';
        let badgeText = 'Sin consultar';
        let ssoBtn = '';

        if (tok.status === 'saml') {
          badgeClass = 'mgg-badge-saml';
          badgeText = 'Requiere SAML SSO (403)';
          const ssoHref = tok.ssoUrl || 'https://github.com/settings/tokens';
          ssoBtn = `<a href="${MGG.escapeHtml(
            ssoHref
          )}" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm mgg-btn-sso">Autorizar SSO ↗</a>`;
        } else if (tok.status === 'invalid') {
          badgeClass = 'mgg-badge-err';
          badgeText = 'Inválido / Expirado (401)';
        } else if (MGG.isTokenCurrentlyExhausted(tok)) {
          badgeClass = 'mgg-badge-err';
          const resetStr = tok.resetAt ? ` (reset ${MGG.formatResetTime(tok.resetAt)})` : '';
          badgeText = `Agotado 0/${tok.limit || 5000}${resetStr}`;
        } else if (tok.remaining !== null && tok.remaining !== undefined) {
          badgeClass = tok.remaining < 100 ? 'mgg-badge-warn' : 'mgg-badge-ok';
          badgeText = `Cuota: ${tok.remaining}/${tok.limit || 5000}`;
        }

        const useBtn = isActive
          ? '<span class="mgg-btn mgg-btn-sm mgg-btn-active-pill">ACTIVO</span>'
          : `<button type="button" class="mgg-btn mgg-btn-sm mgg-use-tok" data-idx="${idx}">Usar</button>`;

        return `
          <div class="mgg-token-row ${isActive ? 'mgg-token-active' : ''}">
            <div class="mgg-token-info">
              <span class="mgg-token-alias">${MGG.escapeHtml(tok.label)}</span>
              <span class="mgg-token-mask">${MGG.escapeHtml(MGG.maskToken(tok.value))}</span>
              <span class="mgg-token-badge ${badgeClass}">${MGG.escapeHtml(badgeText)}</span>
            </div>
            <div class="mgg-token-actions">
              ${ssoBtn}
              ${useBtn}
              <button type="button" class="mgg-btn mgg-btn-sm mgg-btn-close mgg-del-tok" data-idx="${idx}">Eliminar</button>
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.mgg-use-tok').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx'));
        if (!Number.isNaN(idx) && state.tokens[idx]) {
          state.activeTokenIndex = idx;
          if (state.tokens[idx].status === 'saml') state.tokens[idx].status = 'unknown';
          MGG.saveGlobalTokens();
          updateControlsUI();
          setStatus(`Cambiado manualmente a ${state.tokens[idx].label}. Recargando...`);
          loadRepoData();
        }
      });
    });

    listEl.querySelectorAll('.mgg-del-tok').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-idx'));
        if (Number.isNaN(idx) || !state.tokens[idx]) return;
        const removed = state.tokens.splice(idx, 1)[0];
        if (state.activeTokenIndex >= state.tokens.length) {
          state.activeTokenIndex = Math.max(0, state.tokens.length - 1);
        }
        MGG.saveGlobalTokens();
        updateControlsUI();
        setStatus(`PAT "${removed.label}" eliminado.`);
      });
    });
  }

  function updateRateDisplay() {
    const rateEl = ui.overlay?.querySelector('#mgg-rate-text');
    if (!rateEl) return;

    if (state.activeSource === 'web' || state.connectionMode === 'web') {
      rateEl.innerHTML =
        '<span class="mgg-mode-pill">FUENTE: SESIÓN WEB (SAML SSO / SIN LÍMITE API)</span>';
      return;
    }

    if (state.tokens.length > 0) {
      const active = state.tokens[state.activeTokenIndex];
      const remText =
        active?.remaining !== null && active?.remaining !== undefined
          ? `${active.remaining}/${active.limit || 5000}`
          : 'pendiente';
      rateEl.textContent = `PAT activo: ${active?.label || '-'} (${state.activeTokenIndex + 1}/${
        state.tokens.length
      }) | API Rate: ${remText}`;
    } else {
      const rem = state.anonRateRemaining !== null ? `${state.anonRateRemaining}/60` : '60/h máx.';
      rateEl.textContent = `API pública | Rate: ${rem}`;
    }
  }

  function setStatus(text) {
    const el = ui.overlay?.querySelector('#mgg-status-text');
    if (el) el.textContent = text;
    updateRateDisplay();
  }

  async function openModal() {
    const repo = MGG.parseGitHubRepo();
    if (!repo) return;
    ensureUI();

    const repoChanged = !state.repo || state.repo.fullName !== repo.fullName;
    state.repo = repo;
    ui.overlay.querySelector('#mgg-repo-label').textContent = repo.fullName;
    ui.overlay.classList.add('mgg-open');

    await MGG.loadGlobalTokens();

    if (repoChanged || state.branches.length === 0) {
      MGG.explorer.closeContextMenu();
      MGG.explorer.close();
      MGG.explorer.closeDialog();
      state.branches = [];
      state.tags = [];
      state.tagsBySha.clear();
      state.orderedCommits = [];
      state.commitMap.clear();
      state.branchHeadMap.clear();
      MGG.resetNavigationAndSelection();
      state.explorer.commitDiffCache.clear();
      state.explorer.fileHistoryCache.clear();

      await MGG.loadRepoConfig(repo.fullName);
      await MGG.loadRepoParentsCache(repo.fullName);
      updateControlsUI();
      loadRepoData();
    } else {
      updateControlsUI();
    }
  }

  function closeModal() {
    MGG.explorer.closeContextMenu();
    MGG.explorer.closeDialog();
    MGG.explorer.close();
    ui.overlay?.classList.remove('mgg-open');
  }

  // =====================================================================
  // MENÚS CONTEXTUALES (CLIC SECUNDARIO EN RAMAS, TAGS Y COMMITS)
  // =====================================================================

  function openBranchContextMenu(e, branchName) {
    if (!state.repo || !branchName) return;
    e.preventDefault();
    e.stopPropagation();

    const { owner, repo } = state.repo;
    const isSelected = state.selectedBranches.has(branchName);
    const branchUrl = `https://github.com/${owner}/${repo}/tree/${MGG.encodeBranchPath(branchName)}`;

    MGG.explorer.openContextMenu(e.clientX, e.clientY, `Rama: ${branchName}`, [
      {
        icon: isSelected ? '👁‍🗨' : '➕',
        label: isSelected ? 'Ocultar columna del grafo' : 'Mostrar columna en el grafo',
        onClick: () => {
          if (isSelected) state.selectedBranches.delete(branchName);
          else state.selectedBranches.add(branchName);
          MGG.saveCurrentRepoConfig();
          renderBranchSidebar();
          loadSelectedBranchesCommits();
        }
      },
      { separator: true },
      {
        icon: '🔀',
        label: 'Crear Pull Request desde esta rama (origen)',
        variant: 'cyan',
        onClick: () => MGG.explorer.openCreatePrDialog({ head: branchName })
      },
      {
        icon: '🎯',
        label: 'Crear Pull Request hacia esta rama (destino)',
        variant: 'cyan',
        onClick: () => MGG.explorer.openCreatePrDialog({ base: branchName })
      },
      { separator: true },
      {
        icon: '📋',
        label: 'Copiar nombre de la rama',
        onClick: () => {
          navigator.clipboard?.writeText(branchName);
          setStatus(`Nombre copiado: ${branchName}`);
        }
      },
      {
        icon: '↗',
        label: 'Abrir rama en GitHub',
        onClick: () => window.open(branchUrl, '_blank', 'noopener,noreferrer')
      }
    ]);
  }

  function openTagContextMenu(e, tagName, tagSha) {
    if (!state.repo || !tagName) return;
    e.preventDefault();
    e.stopPropagation();

    const { owner, repo } = state.repo;
    const tagUrl = `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`;

    MGG.explorer.openContextMenu(e.clientX, e.clientY, `Tag: ${tagName}`, [
      {
        icon: '🎯',
        label: 'Ubicar commit en el grafo',
        disabled: !tagSha,
        onClick: () => {
          if (!selectAndScrollToSha(tagSha)) {
            setStatus(`Tag "${tagName}" fuera del rango actual. Abriendo Explorador...`);
            MGG.explorer.openForCommit(tagSha);
          }
        }
      },
      {
        icon: '📂',
        label: 'Explorar archivos / Diff del tag',
        disabled: !tagSha,
        onClick: () => MGG.explorer.openForCommit(tagSha)
      },
      { separator: true },
      {
        icon: '📋',
        label: 'Copiar nombre del tag',
        onClick: () => {
          navigator.clipboard?.writeText(tagName);
          setStatus(`Tag copiado: ${tagName}`);
        }
      },
      tagSha
        ? {
            icon: '🔑',
            label: `Copiar SHA (${tagSha.slice(0, 7)})`,
            onClick: () => {
              navigator.clipboard?.writeText(tagSha);
              setStatus(`SHA copiado: ${tagSha}`);
            }
          }
        : null,
      {
        icon: '↗',
        label: 'Abrir tag en GitHub',
        onClick: () => window.open(tagUrl, '_blank', 'noopener,noreferrer')
      },
      { separator: true },
      {
        icon: '🗑',
        label: `Eliminar Tag "${tagName}"`,
        variant: 'danger',
        onClick: () => MGG.explorer.openDeleteTagDialog(tagName, tagSha)
      }
    ]);
  }

  function openCommitContextMenu(e, commit) {
    if (!state.repo || !commit) return;
    e.preventDefault();
    e.stopPropagation();

    const prNum = MGG.extractPrNumberFromMessage(commit.message);
    const suggestedHead =
      commit.headBranches?.[0] || Array.from(commit.branches || [])[0] || '';
    const commitTags = MGG.getTagsForSha(commit.sha);
    const isInSelection = state.selectedShas.has(commit.sha);

    const items = [
      {
        icon: '📂',
        label: 'Explorar archivos / Diff (pantalla completa)',
        onClick: () => MGG.explorer.openForCommit(commit)
      },
      {
        icon: isInSelection && state.selectedShas.size > 1 ? '➖' : '➕',
        label:
          isInSelection && state.selectedShas.size > 1
            ? 'Quitar de la selección múltiple'
            : 'Agregar a la selección múltiple',
        variant: 'cyan',
        onClick: () => {
          const next = new Set(state.selectedShas);
          if (next.has(commit.sha) && next.size > 1) next.delete(commit.sha);
          else next.add(commit.sha);
          state.lastAnchorSha = commit.sha;
          applySelection(Array.from(next), commit.sha, { pushHistory: true });
        }
      },
      {
        icon: '🔀',
        label: suggestedHead ? `Crear Pull Request desde ${suggestedHead}` : 'Crear Pull Request...',
        variant: 'cyan',
        onClick: () => MGG.explorer.openCreatePrDialog({ head: suggestedHead })
      },
      { separator: true },
      {
        icon: '🏷',
        label: 'Crear Tag en este commit',
        variant: 'warn',
        onClick: () => MGG.explorer.openCreateTagDialog(commit)
      }
    ];

    for (const tName of commitTags) {
      items.push({
        icon: '🗑',
        label: `Eliminar Tag "${tName}"`,
        variant: 'danger',
        onClick: () => MGG.explorer.openDeleteTagDialog(tName, commit.sha)
      });
    }

    items.push(
      {
        icon: '↺',
        label: prNum ? `Revertir Pull Request #${prNum}` : 'Pull Request Revert...',
        variant: 'cyan',
        onClick: () => MGG.explorer.openPrRevertDialog(commit, prNum)
      },
      { separator: true },
      {
        icon: '📋',
        label: `Copiar SHA (${commit.shortSha})`,
        onClick: () => {
          navigator.clipboard?.writeText(commit.sha);
          setStatus(`SHA copiado: ${commit.sha}`);
        }
      },
      {
        icon: '📝',
        label: 'Copiar mensaje del commit',
        onClick: () => {
          navigator.clipboard?.writeText(commit.message);
          setStatus('Mensaje del commit copiado.');
        }
      },
      {
        icon: '↗',
        label: 'Abrir commit en GitHub',
        onClick: () => window.open(commit.htmlUrl, '_blank', 'noopener,noreferrer')
      }
    );

    MGG.explorer.openContextMenu(
      e.clientX,
      e.clientY,
      `Commit ${commit.shortSha} — ${commit.subject}`,
      items
    );
  }

  // =====================================================================
  // CARGA DE RAMAS, TAGS Y COMMITS
  // =====================================================================

  async function loadRepoData() {
    if (!state.repo) return;
    const { owner, repo } = state.repo;
    const graphContainer = ui.overlay.querySelector('#mgg-graph-scroll');
    graphContainer.innerHTML =
      '<div class="mgg-empty-state">Conectando con la Matrix de GitHub...</div>';

    let res = null;

    if (state.connectionMode === 'web') {
      state.activeSource = 'web';
      setStatus(`Cargando ramas y tags vía Sesión Web (SAML) de ${owner}/${repo}...`);
      res = await MGG.github.webFetchBranches(owner, repo);
    } else {
      state.activeSource = 'api';
      setStatus(`Cargando ramas vía API de ${owner}/${repo}...`);
      res = await MGG.github.apiFetchAllBranches(owner, repo);

      if ((!res || !res.ok) && state.connectionMode === 'auto') {
        const reason = res?.isSaml
          ? 'SAML SSO requerido en PAT'
          : `API HTTP ${res?.status || 'red'}`;
        setStatus(`${reason}. Cambiando automáticamente a Sesión Web (SAML)...`);
        state.activeSource = 'web';
        res = await MGG.github.webFetchBranches(owner, repo);
      }
    }

    updateRateDisplay();

    if (!res || !res.ok) {
      const detail = res?.error ? ` — Detalle: ${res.error}` : '';
      let msg = `Error HTTP ${res?.status || 'red'} al obtener ramas.${detail}`;
      let actionsHtml = '';

      if (res?.isSaml) {
        msg =
          'Organización protegida por SAML SSO: GitHub bloqueó tu PAT. Cambia a Modo Sesión Web (SAML) o autoriza tu PAT para esta organización.';
        actionsHtml = `
          <div class="mgg-error-actions">
            <button type="button" id="mgg-switch-web-btn" class="mgg-btn">Usar Sesión Web (SAML) ahora</button>
            <a href="${MGG.escapeHtml(
              res.ssoUrl || 'https://github.com/settings/tokens'
            )}" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sso">Autorizar PAT con SAML SSO ↗</a>
          </div>
        `;
      } else if (res?.status === 404 || res?.status === 403 || res?.status === 429) {
        msg = `No se pudo leer vía API (HTTP ${res.status}). Prueba usando Modo Sesión Web (SAML) o revisa tus tokens en "🔑 PATs".`;
        actionsHtml = `
          <div class="mgg-error-actions">
            <button type="button" id="mgg-switch-web-btn" class="mgg-btn">Usar Sesión Web (SAML)</button>
          </div>
        `;
      }

      graphContainer.innerHTML = `<div class="mgg-error-box">${MGG.escapeHtml(msg)}${actionsHtml}</div>`;
      const switchBtn = graphContainer.querySelector('#mgg-switch-web-btn');
      if (switchBtn) {
        switchBtn.addEventListener('click', () => {
          state.connectionMode = 'web';
          MGG.saveCurrentRepoConfig();
          updateControlsUI();
          loadRepoData();
        });
      }
      setStatus('Error al cargar ramas');
      return;
    }

    state.branches = Array.isArray(res.data) ? res.data : [];

    const tagsPromise = MGG.github.fetchRepoTags(owner, repo);

    if (state.branches.length === 0) {
      await tagsPromise;
      renderBranchSidebar();
      graphContainer.innerHTML =
        '<div class="mgg-empty-state">No se encontraron ramas visibles en este repositorio.</div>';
      setStatus('0 ramas encontradas');
      return;
    }

    const availableNames = new Set(state.branches.map((b) => b.name));
    for (const existing of Array.from(state.selectedBranches)) {
      if (!availableNames.has(existing)) state.selectedBranches.delete(existing);
    }

    if (state.selectedBranches.size === 0) {
      const sortedInit = [...state.branches].sort((a, b) => {
        const p = ['main', 'master', 'develop', 'dev'];
        const ia = p.indexOf(a.name.toLowerCase());
        const ib = p.indexOf(b.name.toLowerCase());
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return MGG.compareBranchesBySort(a, b);
      });
      sortedInit.slice(0, 4).forEach((b) => state.selectedBranches.add(b.name));
      MGG.saveCurrentRepoConfig();
    }

    await tagsPromise;
    renderBranchSidebar();
    await loadSelectedBranchesCommits();

    if (state.branchSort.startsWith('date_')) {
      MGG.github.hydrateMissingBranchDatesIfNeeded();
    }
  }

  function renderPrefixChips() {
    const container = ui.overlay?.querySelector('#mgg-prefix-chips');
    if (!container) return;

    const groups = new Map();
    for (const b of state.branches) {
      const slash = b.name.indexOf('/');
      if (slash > 0) {
        const prefix = b.name.slice(0, slash);
        if (!groups.has(prefix)) groups.set(prefix, []);
        groups.get(prefix).push(b.name);
      }
    }

    if (groups.size === 0) {
      container.innerHTML = '';
      return;
    }

    const sortedPrefixes = Array.from(groups.keys()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );

    container.innerHTML = sortedPrefixes
      .map((prefix) => {
        const list = groups.get(prefix);
        const selCount = list.filter((n) => state.selectedBranches.has(n)).length;
        const cls =
          selCount === list.length
            ? 'mgg-chip-full'
            : selCount > 0
              ? 'mgg-chip-partial'
              : '';
        return `<button type="button" class="mgg-prefix-chip ${cls}" data-prefix="${MGG.escapeHtml(
          prefix
        )}" title="Clic para agregar/quitar todas las ramas de ${MGG.escapeHtml(prefix)}/">${MGG.escapeHtml(
          prefix
        )}/ (${selCount}/${list.length})</button>`;
      })
      .join('');

    container.querySelectorAll('.mgg-prefix-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prefix = btn.getAttribute('data-prefix');
        const list = groups.get(prefix) || [];
        const allSelected = list.every((n) => state.selectedBranches.has(n));
        applyPrefixAction(`${prefix}/`, !allSelected);
      });
    });
  }

  function renderTagsSidebar() {
    const sectionEl = ui.overlay?.querySelector('#mgg-tags-section');
    const titleEl = ui.overlay?.querySelector('#mgg-tags-title');
    const listEl = ui.overlay?.querySelector('#mgg-tags-list');
    if (!titleEl || !listEl || !sectionEl) return;

    const filteredTags = state.tags.filter(
      (t) => !state.branchFilter || t.name.toLowerCase().includes(state.branchFilter)
    );

    const isCollapsed = !state.branchFilter && state.tagsCollapsed;
    titleEl.textContent = `${isCollapsed ? '▸' : '▾'} 🏷 TAGS (${filteredTags.length})`;
    listEl.classList.toggle('mgg-collapsed', isCollapsed);
    sectionEl.classList.toggle('mgg-tags-is-collapsed', isCollapsed);

    if (filteredTags.length === 0) {
      listEl.innerHTML =
        '<div style="font-size:10.5px; color:#7a682a; padding:4px 6px;">Sin tags en este repositorio</div>';
      return;
    }

    listEl.innerHTML = filteredTags
      .map((t) => {
        const shortSha = t.sha ? t.sha.slice(0, 7) : '';
        return `
          <div class="mgg-tag-item" data-mgg-ctx="1" data-tag-sha="${MGG.escapeHtml(
            t.sha
          )}" data-tag-name="${MGG.escapeHtml(t.name)}" title="Tag: ${MGG.escapeHtml(
          t.name
        )}${shortSha ? ` (${shortSha})` : ''} — Clic para ubicar | Clic derecho para opciones">
            <span class="mgg-tag-item-name">🏷 ${MGG.escapeHtml(t.name)}</span>
            <span class="mgg-tag-item-sha">${MGG.escapeHtml(shortSha)}</span>
            <button type="button" class="mgg-tag-item-del" data-del-tag="${MGG.escapeHtml(
              t.name
            )}" data-del-sha="${MGG.escapeHtml(t.sha)}" title="Eliminar tag ${MGG.escapeHtml(
          t.name
        )}">✕</button>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.mgg-tag-item').forEach((item) => {
      const sha = item.getAttribute('data-tag-sha');
      const name = item.getAttribute('data-tag-name');

      item.addEventListener('click', (e) => {
        if (e.target.closest('.mgg-tag-item-del')) return;
        if (!sha) {
          setStatus(`El tag "${name}" no tiene SHA resuelto.`);
          return;
        }
        const found = selectAndScrollToSha(sha);
        if (!found) {
          setStatus(`Tag "${name}" (${sha.slice(0, 7)}) fuera de la vista actual. Abriendo Explorador...`);
          MGG.explorer.openForCommit(sha);
        }
      });

      item.addEventListener('contextmenu', (e) => {
        openTagContextMenu(e, name, sha);
      });
    });

    listEl.querySelectorAll('.mgg-tag-item-del').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tagName = btn.getAttribute('data-del-tag');
        const tagSha = btn.getAttribute('data-del-sha');
        MGG.explorer.openDeleteTagDialog(tagName, tagSha);
      });
    });
  }

  function renderBranchSidebar() {
    const listEl = ui.overlay.querySelector('#mgg-branch-list');
    const countEl = ui.overlay.querySelector('#mgg-branch-count');
    const orderedSelected = MGG.getOrderedSelectedBranches();
    const colorByBranch = new Map();
    orderedSelected.forEach((name, idx) => colorByBranch.set(name, MGG.getBranchColor(idx)));

    countEl.textContent = `${state.selectedBranches.size}/${state.branches.length}`;
    renderPrefixChips();
    renderTagsSidebar();

    const filtered = state.branches.filter((b) =>
      b.name.toLowerCase().includes(state.branchFilter)
    );

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="mgg-empty-state" style="padding:16px;">Sin ramas coincidentes</div>';
      return;
    }

    const treeRoot = MGG.buildBranchTree(filtered);

    function renderBranchRowHtml(leafName, branch) {
      const isChecked = state.selectedBranches.has(branch.name);
      const color = isChecked ? colorByBranch.get(branch.name) : '#194d26';
      const dotShadow = isChecked ? '0 0 6px ' + color : 'none';
      const dateStr = MGG.formatShortDate(branch.timestamp);
      const dateHtml = dateStr ? `<span class="mgg-branch-date">${MGG.escapeHtml(dateStr)}</span>` : '';

      return `
        <label class="mgg-branch-item ${
          isChecked ? 'mgg-selected' : ''
        }" data-mgg-ctx="1" data-branch-row="${MGG.escapeHtml(
        branch.name
      )}" title="${MGG.escapeHtml(branch.name)} (Clic derecho para opciones)">
          <input type="checkbox" class="mgg-branch-chk" data-branch="${MGG.escapeHtml(
            branch.name
          )}" ${isChecked ? 'checked' : ''} />
          <span class="mgg-color-dot" style="background:${color}; box-shadow:${dotShadow};"></span>
          <span class="mgg-branch-name">${MGG.escapeHtml(leafName)}</span>
          ${dateHtml}
        </label>
      `;
    }

    function renderNodeHtml(node) {
      let html = '';

      for (const folder of node.sortedFolders) {
        const isCollapsed = !state.branchFilter && state.collapsedFolders.has(folder.fullPrefix);
        const total = folder.allBranches.length;
        const selectedCount = folder.allBranches.filter((b) =>
          state.selectedBranches.has(b.name)
        ).length;
        const allChecked = total > 0 && selectedCount === total;
        const indeterminate = selectedCount > 0 && selectedCount < total;

        html += `
          <div class="mgg-tree-folder">
            <div class="mgg-tree-folder-row" title="${MGG.escapeHtml(
              folder.fullPrefix
            )} (${selectedCount}/${total})">
              <button type="button" class="mgg-tree-toggle" data-folder="${MGG.escapeHtml(
                folder.fullPrefix
              )}">${isCollapsed ? '▸' : '▾'}</button>
              <input type="checkbox" class="mgg-folder-chk" data-folder="${MGG.escapeHtml(
                folder.fullPrefix
              )}" ${allChecked ? 'checked' : ''} data-indeterminate="${indeterminate ? '1' : '0'}" />
              <span class="mgg-tree-folder-name" data-folder="${MGG.escapeHtml(
                folder.fullPrefix
              )}">${MGG.escapeHtml(folder.name)}/</span>
              <span class="mgg-tree-count">${selectedCount}/${total}</span>
            </div>
            <div class="mgg-tree-children ${isCollapsed ? 'mgg-collapsed' : ''}">
              ${renderNodeHtml(folder)}
            </div>
          </div>
        `;
      }

      for (const item of node.branches) {
        html += renderBranchRowHtml(item.leafName, item.branch);
      }

      return html;
    }

    listEl.innerHTML = renderNodeHtml(treeRoot);

    listEl.querySelectorAll('.mgg-folder-chk').forEach((chk) => {
      if (chk.getAttribute('data-indeterminate') === '1') chk.indeterminate = true;
      chk.addEventListener('change', (e) => {
        const prefix = e.target.getAttribute('data-folder');
        const shouldAdd = e.target.checked;
        state.branches.forEach((b) => {
          if (b.name.startsWith(prefix)) {
            if (shouldAdd) state.selectedBranches.add(b.name);
            else state.selectedBranches.delete(b.name);
          }
        });
        MGG.saveCurrentRepoConfig();
        renderBranchSidebar();
        loadSelectedBranchesCommits();
      });
    });

    const toggleFolder = (prefix) => {
      if (state.collapsedFolders.has(prefix)) state.collapsedFolders.delete(prefix);
      else state.collapsedFolders.add(prefix);
      MGG.saveCurrentRepoConfig();
      renderBranchSidebar();
    };

    listEl.querySelectorAll('.mgg-tree-toggle, .mgg-tree-folder-name').forEach((el) => {
      el.addEventListener('click', () => {
        toggleFolder(el.getAttribute('data-folder'));
      });
    });

    listEl.querySelectorAll('.mgg-branch-chk').forEach((checkbox) => {
      checkbox.addEventListener('change', (e) => {
        const name = e.target.getAttribute('data-branch');
        if (e.target.checked) state.selectedBranches.add(name);
        else state.selectedBranches.delete(name);
        MGG.saveCurrentRepoConfig();
        renderBranchSidebar();
        loadSelectedBranchesCommits();
      });
    });

    listEl.querySelectorAll('.mgg-branch-item[data-branch-row]').forEach((row) => {
      row.addEventListener('contextmenu', (e) => {
        const branchName = row.getAttribute('data-branch-row');
        openBranchContextMenu(e, branchName);
      });
    });
  }

  function assignColumnsToCommits() {
    const selected = MGG.getOrderedSelectedBranches();
    const commitMap = state.commitMap;
    const branchHeadMap = state.branchHeadMap;

    const headBranchesBySha = new Map();
    selected.forEach((branchName) => {
      const headSha = branchHeadMap.get(branchName);
      if (headSha) {
        if (!headBranchesBySha.has(headSha)) headBranchesBySha.set(headSha, []);
        headBranchesBySha.get(headSha).push(branchName);
      }
    });

    for (const commit of commitMap.values()) {
      commit.firstParentBranches.clear();
      commit.headBranches = headBranchesBySha.get(commit.sha) || [];
      commit.colIndex = -1;
      commit.subLane = 0;
    }

    selected.forEach((branchName) => {
      let currSha = branchHeadMap.get(branchName);
      const visited = new Set();
      while (currSha && commitMap.has(currSha) && !visited.has(currSha)) {
        visited.add(currSha);
        const node = commitMap.get(currSha);
        node.firstParentBranches.add(branchName);
        currSha = node.parents[0] || null;
      }
    });

    for (const commit of commitMap.values()) {
      let assignedCol = -1;

      if (commit.headBranches.length > 0) {
        assignedCol = selected.indexOf(commit.headBranches[0]);
      }

      if (assignedCol === -1 && commit.firstParentBranches.size > 0) {
        for (let i = 0; i < selected.length; i++) {
          if (commit.firstParentBranches.has(selected[i])) {
            assignedCol = i;
            break;
          }
        }
      }

      commit.colIndex = assignedCol;
      commit.subLane = 0;
    }

    const mergesAsc = Array.from(commitMap.values())
      .filter((c) => c.parents.length > 1 && c.colIndex !== -1)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const mergeCommit of mergesAsc) {
      const targetCol = mergeCommit.colIndex;
      const stack = mergeCommit.parents.slice(1);
      const visited = new Set();
      while (stack.length > 0) {
        const sha = stack.pop();
        if (!sha || visited.has(sha) || !commitMap.has(sha)) continue;
        visited.add(sha);
        const node = commitMap.get(sha);
        if (node.colIndex === -1) {
          node.colIndex = targetCol;
          node.subLane = 1;
          for (const p of node.parents) stack.push(p);
        }
      }
    }

    for (const commit of commitMap.values()) {
      if (commit.colIndex === -1) {
        let fallbackCol = 0;
        for (let i = selected.length - 1; i >= 0; i--) {
          if (commit.branches.has(selected[i])) {
            fallbackCol = i;
            break;
          }
        }
        commit.colIndex = fallbackCol;
        if (commit.firstParentBranches.size === 0) commit.subLane = 1;
      }
    }
  }

  function recomputeColumnsAndRender() {
    if (state.commitMap.size > 0) assignColumnsToCommits();
    renderBranchSidebar();
    renderGraph();
  }

  async function loadSelectedBranchesCommits() {
    const selected = MGG.getOrderedSelectedBranches();
    const graphContainer = ui.overlay.querySelector('#mgg-graph-scroll');
    const detailPanel = ui.overlay.querySelector('#mgg-detail-panel');
    detailPanel.classList.remove('mgg-visible');

    if (selected.length === 0) {
      state.orderedCommits = [];
      state.commitMap.clear();
      MGG.resetNavigationAndSelection();
      updateNavBarUI();
      setStatus('Selecciona al menos una rama en el panel izquierdo.');
      graphContainer.innerHTML =
        '<div class="mgg-empty-state">Selecciona una o más ramas en el panel izquierdo para construir el grafo.</div>';
      return;
    }

    state.isLoading = true;
    const sourceLabel = state.activeSource === 'web' ? 'Sesión Web (SAML)' : 'API GitHub';
    setStatus(`Descargando hasta ${state.commitsPerBranch} commits/rama de ${selected.length} rama(s)...`);
    graphContainer.innerHTML = `<div class="mgg-empty-state">Descargando historial de ${
      selected.length
    } rama(s) vía ${MGG.escapeHtml(sourceLabel)}...</div>`;

    const { owner, repo, fullName } = state.repo;
    const branchHeadMap = new Map();
    state.branches.forEach((b) => {
      if (b.commit?.sha) branchHeadMap.set(b.name, b.commit.sha);
    });

    let results = [];
    const exactParentsMap = new Map(state.parentsCache);

    if (state.activeSource === 'web') {
      const desiredDepth = Math.max(400, state.commitsPerBranch * Math.min(selected.length, 4));
      const [networkData, branchResults] = await Promise.all([
        MGG.github.webFetchNetworkData(owner, repo, desiredDepth),
        Promise.all(
          selected.map(async (branchName) => {
            const res = await MGG.github.webFetchBranchCommits(
              owner,
              repo,
              branchName,
              state.commitsPerBranch,
              null,
              branchHeadMap.get(branchName)
            );
            return { branchName, res };
          })
        )
      ]);

      networkData.parentsMap.forEach((pShas, sha) => {
        exactParentsMap.set(sha, pShas);
        state.parentsCache.set(sha, pShas);
      });

      networkData.headsMap.forEach((sha, bName) => {
        if (!branchHeadMap.get(bName)) branchHeadMap.set(bName, sha);
        const netCommit = networkData.commitsMap.get(sha);
        if (netCommit) {
          const bObj = state.branches.find((x) => x.name === bName);
          const ts = MGG.parseTimestamp(netCommit.commit?.committer?.date);
          if (bObj && !bObj.timestamp && ts) bObj.timestamp = ts;
        }
      });

      results = branchResults.map(({ branchName, res }) => {
        if ((!res || !res.ok || !res.data || res.data.length === 0) && networkData.commitsMap.size > 0) {
          const head = branchHeadMap.get(branchName) || networkData.headsMap.get(branchName);
          const fromNet = MGG.github.walkNetworkBranchCommits(
            head,
            networkData.commitsMap,
            state.commitsPerBranch
          );
          if (fromNet.length > 0) {
            return { branchName, res: { ok: true, status: 200, data: fromNet } };
          }
        }
        return { branchName, res };
      });
    } else {
      results = await Promise.all(
        selected.map(async (branchName) => {
          const res = await MGG.github.apiFetchBranchCommits(owner, repo, branchName, state.commitsPerBranch);
          return { branchName, res };
        })
      );
    }

    const failed = results.find((r) => !r.res || !r.res.ok);
    if (failed) {
      const detail = failed.res?.error ? ` (${failed.res.error})` : '';
      graphContainer.innerHTML = `<div class="mgg-error-box">Error (${
        failed.res?.status || 'red'
      }) al leer commits de la rama <strong>${MGG.escapeHtml(
        failed.branchName
      )}</strong>${MGG.escapeHtml(detail)}.</div>`;
      setStatus('Error al cargar commits');
      state.isLoading = false;
      return;
    }

    const commitBranchesMap = new Map();
    const uniqueRawCommits = new Map();

    for (const { branchName, res } of results) {
      const list = Array.isArray(res.data) ? res.data : [];
      if (list.length > 0) {
        if (!branchHeadMap.get(branchName)) branchHeadMap.set(branchName, list[0].sha);
        const bObj = state.branches.find((x) => x.name === branchName);
        const headTs = MGG.parseTimestamp(list[0].commit?.committer?.date || list[0].commit?.author?.date);
        if (bObj && headTs && headTs > (bObj.timestamp || 0)) bObj.timestamp = headTs;
      }
      for (const item of list) {
        if (!commitBranchesMap.has(item.sha)) commitBranchesMap.set(item.sha, new Set());
        commitBranchesMap.get(item.sha).add(branchName);

        if (!uniqueRawCommits.has(item.sha)) uniqueRawCommits.set(item.sha, item);

        const directParents = (item.parents || []).map((p) => p.sha).filter((p) => p && p !== item.sha);
        if (directParents.length > 0) {
          exactParentsMap.set(item.sha, directParents);
          state.parentsCache.set(item.sha, directParents);
        }
      }
    }

    if (state.activeSource === 'web') {
      const missingShas = Array.from(uniqueRawCommits.values())
        .filter((item) => !exactParentsMap.has(item.sha))
        .sort((a, b) => {
          const ta = MGG.parseTimestamp(a.commit?.committer?.date || a.commit?.author?.date);
          const tb = MGG.parseTimestamp(b.commit?.committer?.date || b.commit?.author?.date);
          return tb - ta;
        })
        .map((item) => item.sha);

      const maxToResolve = Math.min(missingShas.length, 260);
      if (maxToResolve > 0) {
        let resolvedCount = 0;
        let cacheUpdated = false;
        const batchSize = 8;

        for (let i = 0; i < maxToResolve; i += batchSize) {
          const batch = missingShas.slice(i, i + batchSize);
          setStatus(
            `Resolviendo grafo real (padres/merges): ${Math.min(
              i + batch.length,
              maxToResolve
            )}/${maxToResolve} (se guarda en caché)...`
          );

          await Promise.all(
            batch.map(async (sha) => {
              const pShas = await MGG.github.webFetchSingleCommitParents(owner, repo, sha);
              if (pShas.length > 0) {
                exactParentsMap.set(sha, pShas);
                state.parentsCache.set(sha, pShas);
                resolvedCount++;
                cacheUpdated = true;
              }
            })
          );

          if (i === 0 && resolvedCount === 0) break;
        }

        if (cacheUpdated) MGG.saveRepoParentsCache(fullName);
      } else if (exactParentsMap.size > 0) {
        MGG.saveRepoParentsCache(fullName);
      }
    }

    const commitMap = new Map();
    let exactParentsCount = 0;

    for (const { branchName, res } of results) {
      const list = Array.isArray(res.data) ? res.data : [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        let parentShas = exactParentsMap.get(item.sha) || [];
        const hasExactParents = parentShas.length > 0;

        if (!hasExactParents && i + 1 < list.length) {
          const myBranches = commitBranchesMap.get(item.sha);
          for (let j = i + 1; j < list.length; j++) {
            const cand = list[j];
            if (cand.sha === item.sha) continue;
            if (MGG.isSubsetSet(myBranches, commitBranchesMap.get(cand.sha))) {
              parentShas = [cand.sha];
              break;
            }
          }
        }

        if (!commitMap.has(item.sha)) {
          if (hasExactParents) exactParentsCount++;
          const dateStr = item.commit?.committer?.date || item.commit?.author?.date || '';
          commitMap.set(item.sha, {
            sha: item.sha,
            shortSha: item.sha.slice(0, 7),
            message: item.commit?.message || '',
            subject: (item.commit?.message || '').split('\n')[0],
            author: item.author?.login || item.commit?.author?.name || 'Desconocido',
            authorEmail: item.commit?.author?.email || '',
            date: dateStr,
            timestamp: MGG.parseTimestamp(dateStr),
            parents: [...parentShas],
            hasExactParents,
            htmlUrl: item.html_url || `https://github.com/${owner}/${repo}/commit/${item.sha}`,
            branches: new Set(commitBranchesMap.get(item.sha) || [branchName]),
            firstParentBranches: new Set(),
            headBranches: [],
            colIndex: -1,
            subLane: 0
          });
        } else {
          commitMap.get(item.sha).branches.add(branchName);
        }
      }
    }

    state.commitMap = commitMap;
    state.branchHeadMap = branchHeadMap;
    assignColumnsToCommits();

    const orderedCommits = topoSortCommits(commitMap);
    state.orderedCommits = orderedCommits;
    state.isLoading = false;

    // Limpiar de la selección SHAs que ya no estén visibles
    for (const s of Array.from(state.selectedShas)) {
      if (!commitMap.has(s)) state.selectedShas.delete(s);
    }
    if (state.activeSha && !commitMap.has(state.activeSha)) {
      state.activeSha = Array.from(state.selectedShas)[0] || null;
    }

    const mergeCount = orderedCommits.filter((c) => c.parents.length > 1).length;
    setStatus(
      `${orderedCommits.length} commits | ${mergeCount} merges | ${state.tags.length} tags | Padres exactos: ${exactParentsCount}/${orderedCommits.length} [${sourceLabel}]`
    );

    updateNavBarUI();
    renderBranchSidebar();
    renderGraph();
  }

  function topoSortCommits(commitMap) {
    const inDegree = new Map();
    for (const sha of commitMap.keys()) inDegree.set(sha, 0);

    for (const commit of commitMap.values()) {
      for (const parentSha of commit.parents) {
        if (parentSha !== commit.sha && commitMap.has(parentSha)) {
          inDegree.set(parentSha, (inDegree.get(parentSha) || 0) + 1);
        }
      }
    }

    const ready = [];
    for (const [sha, deg] of inDegree.entries()) {
      if (deg === 0) ready.push(sha);
    }

    const result = [];
    const seen = new Set();

    while (ready.length > 0) {
      ready.sort((a, b) => commitMap.get(b).timestamp - commitMap.get(a).timestamp);
      const currSha = ready.shift();
      if (seen.has(currSha)) continue;
      seen.add(currSha);

      const commit = commitMap.get(currSha);
      result.push(commit);

      for (const parentSha of commit.parents) {
        if (parentSha === currSha || !commitMap.has(parentSha)) continue;
        const nextDeg = inDegree.get(parentSha) - 1;
        inDegree.set(parentSha, nextDeg);
        if (nextDeg === 0) ready.push(parentSha);
      }
    }

    if (result.length < commitMap.size) {
      const rest = Array.from(commitMap.values())
        .filter((c) => !seen.has(c.sha))
        .sort((a, b) => b.timestamp - a.timestamp);
      result.push(...rest);
    }

    return result;
  }

  // =====================================================================
  // MOTOR DE TRAZADO SVG + FLECHAS DE FLUJO
  // =====================================================================

  function getTargetNodeStopDist(commit) {
    const isHead = commit.headBranches && commit.headBranches.length > 0;
    const isMerge = commit.parents && commit.parents.length > 1;
    if (isHead) return 8.6;
    if (isMerge) return 6.2;
    return 5.4;
  }

  function buildArrowPolygon(fx, fy, tx, ty, stopDist, color, fromSha, toSha, size = 6.2) {
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy);
    if (len < stopDist + 3.5) return '';

    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const tipX = tx - ux * stopDist;
    const tipY = ty - uy * stopDist;
    const baseLen = size;
    const halfW = size * 0.5;
    const notchLen = size * 0.72;

    const p1x = tipX - ux * baseLen + px * halfW;
    const p1y = tipY - uy * baseLen + py * halfW;
    const nx = tipX - ux * notchLen;
    const ny = tipY - uy * notchLen;
    const p2x = tipX - ux * baseLen - px * halfW;
    const p2y = tipY - uy * baseLen - py * halfW;

    const pts = `${tipX.toFixed(1)},${tipY.toFixed(1)} ${p1x.toFixed(1)},${p1y.toFixed(
      1
    )} ${nx.toFixed(1)},${ny.toFixed(1)} ${p2x.toFixed(1)},${p2y.toFixed(1)}`;
    return `<polygon class="mgg-edge mgg-arrow" data-from="${fromSha}" data-to="${toSha}" points="${pts}" fill="${color}" style="color:${color};" />`;
  }

  function buildMidpointArrow(fx, fy, tx, ty, color, fromSha, toSha, size = 5.4) {
    const dx = tx - fx;
    const dy = ty - fy;
    const len = Math.hypot(dx, dy);
    if (len < 120) return '';
    const mx = (fx + tx) / 2;
    const my = (fy + ty) / 2;
    return buildArrowPolygon(
      fx,
      fy,
      mx + (dx / len) * (size * 0.5),
      my + (dy / len) * (size * 0.5),
      0,
      color,
      fromSha,
      toSha,
      size
    );
  }

  function shouldDrawArrow(isIntegrationEdge) {
    if (state.arrowMode === 'none') return false;
    if (state.arrowMode === 'integrations') return isIntegrationEdge;
    return true;
  }

  function computeSourceTreeLanes(commits, commitMap) {
    const activeLanes = [];
    const laneBySha = new Map();
    const colorBySha = new Map();
    const edgeLanes = new Map();
    let maxLanes = 1;
    let nextColor = 0;

    function allocFreeLane(startFrom = 0) {
      for (let i = startFrom; i < activeLanes.length; i++) {
        if (activeLanes[i] === null) return i;
      }
      for (let i = 0; i < startFrom && i < activeLanes.length; i++) {
        if (activeLanes[i] === null) return i;
      }
      activeLanes.push(null);
      return activeLanes.length - 1;
    }

    for (const commit of commits) {
      let lane = activeLanes.findIndex((slot) => slot && slot.sha === commit.sha);
      let colorIdx;

      if (lane === -1) {
        lane = allocFreeLane(0);
        colorIdx = commit.colIndex >= 0 ? commit.colIndex : nextColor++;
      } else {
        colorIdx = activeLanes[lane].colorIdx;
      }

      for (let i = 0; i < activeLanes.length; i++) {
        if (i !== lane && activeLanes[i] && activeLanes[i].sha === commit.sha) {
          activeLanes[i] = null;
        }
      }

      laneBySha.set(commit.sha, lane);
      const nodeColor = MGG.getBranchColor(colorIdx);
      colorBySha.set(commit.sha, nodeColor);

      const validParents = commit.parents.filter((p) => p && p !== commit.sha && commitMap.has(p));

      if (validParents.length === 0) {
        activeLanes[lane] = null;
      } else {
        const p0 = validParents[0];
        const existingP0 = activeLanes.findIndex((slot, idx) => idx !== lane && slot && slot.sha === p0);
        if (existingP0 === -1) {
          activeLanes[lane] = { sha: p0, colorIdx };
          edgeLanes.set(`${commit.sha}->${p0}`, { passLane: lane, color: nodeColor, isMerge: false });
        } else {
          edgeLanes.set(`${commit.sha}->${p0}`, { passLane: lane, color: nodeColor, isMerge: false });
          activeLanes[lane] = null;
        }

        for (let pIdx = 1; pIdx < validParents.length; pIdx++) {
          const mp = validParents[pIdx];
          const existingMp = activeLanes.findIndex((slot) => slot && slot.sha === mp);
          if (existingMp !== -1) {
            edgeLanes.set(`${commit.sha}->${mp}`, {
              passLane: existingMp,
              color: MGG.getBranchColor(activeLanes[existingMp].colorIdx),
              isMerge: true
            });
          } else {
            const newLane = allocFreeLane(lane + 1);
            const mpNode = commitMap.get(mp);
            const mpColorIdx =
              mpNode && mpNode.subLane === 1
                ? 4
                : mpNode && mpNode.colIndex >= 0
                  ? mpNode.colIndex
                  : nextColor++;
            activeLanes[newLane] = { sha: mp, colorIdx: mpColorIdx };
            edgeLanes.set(`${commit.sha}->${mp}`, {
              passLane: newLane,
              color: MGG.getBranchColor(mpColorIdx),
              isMerge: true
            });
          }
        }
      }

      while (activeLanes.length > 1 && activeLanes[activeLanes.length - 1] === null) {
        activeLanes.pop();
      }
      if (activeLanes.length > maxLanes) maxLanes = activeLanes.length;
    }

    return { laneBySha, colorBySha, edgeLanes, maxLanes };
  }

  function buildMergeFlowPath(x2, y2, x1, y1) {
    const dx = x1 - x2;
    const dir = dx >= 0 ? 1 : -1;
    const r = Math.min(8, Math.abs(dx) * 0.45, Math.max(0, y2 - y1) * 0.45);
    if (r < 2) return `M ${x2} ${y2} L ${x2} ${y1} L ${x1} ${y1}`;
    return `M ${x2} ${y2} L ${x2} ${y1 + r} Q ${x2} ${y1}, ${x2 + dir * r} ${y1} L ${x1} ${y1}`;
  }

  function buildBranchFlowPath(x2, y2, x1, y1) {
    const dx = x1 - x2;
    const dir = dx >= 0 ? 1 : -1;
    const r = Math.min(8, Math.abs(dx) * 0.45, Math.max(0, y2 - y1) * 0.45);
    if (r < 2) return `M ${x2} ${y2} L ${x1} ${y2} L ${x1} ${y1}`;
    return `M ${x2} ${y2} L ${x1 - dir * r} ${y2} Q ${x1} ${y2}, ${x1} ${y2 - r} L ${x1} ${y1}`;
  }

  function buildFlowDetourPath(x2, y2, x1, y1, detourX) {
    const dy = Math.max(1, y2 - y1);
    const d1 = detourX - x2;
    const d2 = x1 - detourX;
    const dir1 = d1 >= 0 ? 1 : -1;
    const dir2 = d2 >= 0 ? 1 : -1;
    const r1 = Math.min(7, Math.abs(d1) * 0.45, dy * 0.35);
    const r2 = Math.min(7, Math.abs(d2) * 0.45, dy * 0.35);

    const segs = [`M ${x2} ${y2}`];
    if (Math.abs(d1) >= 1.5) {
      if (r1 < 1.5) segs.push(`L ${detourX} ${y2}`);
      else segs.push(`L ${detourX - dir1 * r1} ${y2} Q ${detourX} ${y2}, ${detourX} ${y2 - r1}`);
    }

    if (Math.abs(d2) < 1.5) {
      segs.push(`L ${x1} ${y1}`);
    } else if (r2 < 1.5) {
      segs.push(`L ${detourX} ${y1} L ${x1} ${y1}`);
    } else {
      segs.push(`L ${detourX} ${y1 + r2} Q ${detourX} ${y1}, ${detourX + dir2 * r2} ${y1} L ${x1} ${y1}`);
    }

    return segs.join(' ');
  }

  function hasIntermediateNodeAtX(commits, row1, row2, targetX, getX) {
    for (let r = row1 + 1; r < row2; r++) {
      if (Math.abs(getX(commits[r]) - targetX) < 4) return true;
    }
    return false;
  }

  // =====================================================================
  // INTERACCIONES DE COLUMNAS (RESIZE + DRAG & DROP + CLIC DERECHO)
  // =====================================================================

  function getMetaCellStyle(metaKey) {
    const w = state.metaWidths[metaKey];
    if (metaKey === 'msg' && (w === null || w === undefined)) {
      return 'flex: 1 1 260px; min-width: 220px;';
    }
    const px = Number(w) || CONSTANTS.DEFAULT_META_WIDTHS[metaKey] || 120;
    return `width: ${px}px; flex: 0 0 ${px}px;`;
  }

  function bindColumnInteractions(graphScroll, selected) {
    graphScroll.querySelectorAll('.mgg-branch-col-resizer').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();

        const branchName = handle.getAttribute('data-branch');
        const headerEl = handle.closest('.mgg-col-header');
        if (headerEl) headerEl.draggable = false;

        const startX = e.clientX;
        const startW = MGG.getBranchWidth(branchName);
        handle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select');

        let rafId = null;
        const onMove = (ev) => {
          const nextW = Math.min(
            CONSTANTS.MAX_BRANCH_COL_WIDTH,
            Math.max(CONSTANTS.MIN_BRANCH_COL_WIDTH, Math.round(startW + (ev.clientX - startX)))
          );
          if (state.columnWidths[branchName] === nextW) return;
          state.columnWidths[branchName] = nextW;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = null;
              renderGraph();
            });
          }
        };

        const onUp = () => {
          if (rafId) cancelAnimationFrame(rafId);
          document.body.classList.remove('mgg-no-select');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
          renderGraph();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const branchName = handle.getAttribute('data-branch');
        delete state.columnWidths[branchName];
        MGG.saveCurrentRepoConfig();
        renderGraph();
      });
    });

    graphScroll.querySelectorAll('.mgg-st-graph-resizer').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const headerEl = handle.closest('.mgg-col-header');
        const startX = e.clientX;
        const startW = headerEl ? headerEl.getBoundingClientRect().width : 140;
        handle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select');

        let rafId = null;
        const onMove = (ev) => {
          const nextW = Math.min(600, Math.max(85, Math.round(startW + (ev.clientX - startX))));
          if (state.sourceTreeGraphWidth === nextW) return;
          state.sourceTreeGraphWidth = nextW;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = null;
              renderGraph();
            });
          }
        };

        const onUp = () => {
          if (rafId) cancelAnimationFrame(rafId);
          document.body.classList.remove('mgg-no-select');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
          renderGraph();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        state.sourceTreeGraphWidth = null;
        MGG.saveCurrentRepoConfig();
        renderGraph();
      });
    });

    graphScroll.querySelectorAll('.mgg-meta-resizer').forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const metaKey = handle.getAttribute('data-meta');
        const headerEl = handle.closest('.mgg-meta-col-head');
        if (headerEl) headerEl.draggable = false;

        const startX = e.clientX;
        const startW = headerEl ? headerEl.getBoundingClientRect().width : state.metaWidths[metaKey] || 120;
        const minW = metaKey === 'msg' ? 140 : 56;
        const maxW = metaKey === 'msg' ? 1100 : 380;

        handle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select');

        let rafId = null;
        const onMove = (ev) => {
          const nextW = Math.min(maxW, Math.max(minW, Math.round(startW + (ev.clientX - startX))));
          if (state.metaWidths[metaKey] === nextW) return;
          state.metaWidths[metaKey] = nextW;
          if (!rafId) {
            rafId = requestAnimationFrame(() => {
              rafId = null;
              renderGraph();
            });
          }
        };

        const onUp = () => {
          if (rafId) cancelAnimationFrame(rafId);
          document.body.classList.remove('mgg-no-select');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
          renderGraph();
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      handle.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const metaKey = handle.getAttribute('data-meta');
        state.metaWidths[metaKey] = CONSTANTS.DEFAULT_META_WIDTHS[metaKey];
        MGG.saveCurrentRepoConfig();
        renderGraph();
      });
    });

    const branchHeaders = graphScroll.querySelectorAll('.mgg-col-header[draggable="true"]');
    branchHeaders.forEach((colEl) => {
      const branchName = colEl.getAttribute('data-branch');

      colEl.addEventListener('contextmenu', (e) => {
        openBranchContextMenu(e, branchName);
      });

      colEl.addEventListener('dragstart', (e) => {
        if (e.target?.classList?.contains('mgg-col-resizer')) {
          e.preventDefault();
          return;
        }
        draggedMetaKey = null;
        draggedBranchName = branchName;
        colEl.classList.add('mgg-col-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `branch:${branchName}`);
        }
      });

      colEl.addEventListener('dragover', (e) => {
        if (!draggedBranchName || draggedBranchName === branchName) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = colEl.getBoundingClientRect();
        const isAfter = e.clientX > rect.left + rect.width / 2;
        colEl.classList.toggle('mgg-drop-before', !isAfter);
        colEl.classList.toggle('mgg-drop-after', isAfter);
      });

      colEl.addEventListener('dragleave', () => {
        colEl.classList.remove('mgg-drop-before', 'mgg-drop-after');
      });

      colEl.addEventListener('drop', (e) => {
        if (!draggedBranchName) return;
        e.preventDefault();
        const isAfter = colEl.classList.contains('mgg-drop-after');
        colEl.classList.remove('mgg-drop-before', 'mgg-drop-after');

        const sourceName = draggedBranchName;
        if (!sourceName || sourceName === branchName) return;

        const nextOrder = [...selected];
        const fromIdx = nextOrder.indexOf(sourceName);
        if (fromIdx === -1) return;
        nextOrder.splice(fromIdx, 1);

        let targetIdx = nextOrder.indexOf(branchName);
        if (targetIdx === -1) return;
        if (isAfter) targetIdx += 1;

        nextOrder.splice(targetIdx, 0, sourceName);

        const remaining = state.customColumnOrder.filter((n) => !nextOrder.includes(n));
        state.customColumnOrder = [...nextOrder, ...remaining];
        MGG.saveCurrentRepoConfig();

        draggedBranchName = null;
        recomputeColumnsAndRender();
      });

      colEl.addEventListener('dragend', () => {
        draggedBranchName = null;
        branchHeaders.forEach((el) =>
          el.classList.remove('mgg-col-dragging', 'mgg-drop-before', 'mgg-drop-after')
        );
      });
    });

    const metaHeaders = graphScroll.querySelectorAll('.mgg-meta-col-head[draggable="true"]');
    metaHeaders.forEach((colEl) => {
      const metaKey = colEl.getAttribute('data-meta-col');

      colEl.addEventListener('dragstart', (e) => {
        if (e.target?.classList?.contains('mgg-col-resizer')) {
          e.preventDefault();
          return;
        }
        draggedBranchName = null;
        draggedMetaKey = metaKey;
        colEl.classList.add('mgg-col-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `meta:${metaKey}`);
        }
      });

      colEl.addEventListener('dragover', (e) => {
        if (!draggedMetaKey || draggedMetaKey === metaKey) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = colEl.getBoundingClientRect();
        const isAfter = e.clientX > rect.left + rect.width / 2;
        colEl.classList.toggle('mgg-drop-before', !isAfter);
        colEl.classList.toggle('mgg-drop-after', isAfter);
      });

      colEl.addEventListener('dragleave', () => {
        colEl.classList.remove('mgg-drop-before', 'mgg-drop-after');
      });

      colEl.addEventListener('drop', (e) => {
        if (!draggedMetaKey) return;
        e.preventDefault();
        const isAfter = colEl.classList.contains('mgg-drop-after');
        colEl.classList.remove('mgg-drop-before', 'mgg-drop-after');

        const sourceKey = draggedMetaKey;
        if (!sourceKey || sourceKey === metaKey) return;

        const nextOrder = [...state.metaColumnOrder];
        const fromIdx = nextOrder.indexOf(sourceKey);
        if (fromIdx === -1) return;
        nextOrder.splice(fromIdx, 1);

        let targetIdx = nextOrder.indexOf(metaKey);
        if (targetIdx === -1) return;
        if (isAfter) targetIdx += 1;

        nextOrder.splice(targetIdx, 0, sourceKey);
        state.metaColumnOrder = nextOrder;
        MGG.saveCurrentRepoConfig();

        draggedMetaKey = null;
        renderGraph();
      });

      colEl.addEventListener('dragend', () => {
        draggedMetaKey = null;
        metaHeaders.forEach((el) =>
          el.classList.remove('mgg-col-dragging', 'mgg-drop-before', 'mgg-drop-after')
        );
      });
    });
  }

  // =====================================================================
  // RENDERIZADO DEL GRAFO PRINCIPAL
  // =====================================================================

  function renderGraph() {
    const graphScroll = ui.overlay.querySelector('#mgg-graph-scroll');
    const prevScrollLeft = graphScroll.scrollLeft;
    const prevScrollTop = graphScroll.scrollTop;

    const selected = MGG.getOrderedSelectedBranches();
    const commits = state.orderedCommits;

    if (selected.length === 0 || commits.length === 0) {
      graphScroll.innerHTML =
        '<div class="mgg-empty-state">No hay commits para mostrar con la selección actual.</div>';
      return;
    }

    const ROW_HEIGHT = CONSTANTS.ROW_HEIGHT;
    const isSourceTreeView = state.graphLayout === 'sourcetree';
    const totalHeight = commits.length * ROW_HEIGHT;
    const rowIndexBySha = new Map();
    commits.forEach((c, idx) => rowIndexBySha.set(c.sha, idx));

    let graphWidth = 0;
    let colHeadersHtml = '';
    let svgRails = '';
    const svgUnderlays = [];
    const svgPaths = [];
    const svgArrows = [];
    const svgNodes = [];

    if (isSourceTreeView) {
      const { laneBySha, colorBySha, edgeLanes, maxLanes } = computeSourceTreeLanes(
        commits,
        state.commitMap
      );
      const autoWidth = Math.max(
        110,
        maxLanes * CONSTANTS.COMPACT_LANE_WIDTH + CONSTANTS.COMPACT_PAD_X * 2
      );
      graphWidth = state.sourceTreeGraphWidth ? Math.max(autoWidth, state.sourceTreeGraphWidth) : autoWidth;

      colHeadersHtml = `
        <div class="mgg-col-header" style="width:${graphWidth}px; color:#00ff41; justify-content:flex-start; padding-left:10px; cursor:default;">
          <span>GRAFO</span>
          <span class="mgg-col-resizer mgg-st-graph-resizer" title="Arrastra para redimensionar (doble clic restablece)"></span>
        </div>
      `;

      const laneX = (l) => CONSTANTS.COMPACT_PAD_X + l * CONSTANTS.COMPACT_LANE_WIDTH;

      commits.forEach((commit, rowIdx) => {
        const myLane = laneBySha.get(commit.sha) ?? 0;
        const x1 = laneX(myLane);
        const y1 = rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const commitColor = colorBySha.get(commit.sha) || '#00ff41';
        const stopDist = getTargetNodeStopDist(commit);

        commit.parents.forEach((parentSha, pIdx) => {
          const parentRow = rowIndexBySha.get(parentSha);
          if (parentRow === undefined) {
            const endY = Math.min(totalHeight, y1 + ROW_HEIGHT * 0.45);
            svgPaths.push(
              `<line class="mgg-edge" data-from="${commit.sha}" data-to="${parentSha}" x1="${x1}" y1="${y1}" x2="${x1}" y2="${endY}" stroke="${commitColor}" style="color:${commitColor};" stroke-width="1.9" stroke-opacity="0.35" stroke-dasharray="2 3" />`
            );
            return;
          }

          const parentLane = laneBySha.get(parentSha) ?? 0;
          const x2 = laneX(parentLane);
          const y2 = parentRow * ROW_HEIGHT + ROW_HEIGHT / 2;
          const edgeInfo = edgeLanes.get(`${commit.sha}->${parentSha}`);
          const passLane = edgeInfo ? edgeInfo.passLane : pIdx > 0 ? parentLane : myLane;
          const passX = laneX(passLane);
          const isIntegrationEdge = pIdx > 0 || x1 !== x2 || passX !== x1;
          const edgeColor = edgeInfo
            ? edgeInfo.color
            : pIdx > 0
              ? colorBySha.get(parentSha) || commitColor
              : commitColor;

          let d;
          let arrowFromX = x2;
          let arrowFromY = y2;

          if (x1 === x2 && passX === x1) {
            d = `M ${x2} ${y2} L ${x1} ${y1}`;
            arrowFromX = x1;
            arrowFromY = y2;
          } else if (passX !== x1 && passX !== x2) {
            d = buildFlowDetourPath(x2, y2, x1, y1, passX);
            arrowFromX = passX;
            arrowFromY = y1;
          } else if (passX === x2) {
            const elbow = Math.min(ROW_HEIGHT * 0.46, Math.max(7, (y2 - y1) * 0.45));
            d = `M ${x2} ${y2} L ${x2} ${y1 + elbow} L ${x1} ${y1}`;
            arrowFromX = x2;
            arrowFromY = y1 + elbow;
          } else {
            const elbow = Math.min(ROW_HEIGHT * 0.46, Math.max(7, (y2 - y1) * 0.45));
            d = `M ${x2} ${y2} L ${x1} ${y2 - elbow} L ${x1} ${y1}`;
            arrowFromX = x1;
            arrowFromY = y2 - elbow;
          }

          svgUnderlays.push(
            `<path d="${d}" fill="none" stroke="#040805" stroke-width="4.0" stroke-linecap="round" stroke-linejoin="round" />`
          );
          svgPaths.push(
            `<path class="mgg-edge" data-from="${commit.sha}" data-to="${parentSha}" d="${d}" fill="none" stroke="${edgeColor}" style="color:${edgeColor};" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`
          );

          if (shouldDrawArrow(isIntegrationEdge)) {
            const arrowSize = isIntegrationEdge ? 5.6 : 4.8;
            const poly = buildArrowPolygon(
              arrowFromX,
              arrowFromY,
              x1,
              y1,
              stopDist,
              edgeColor,
              commit.sha,
              parentSha,
              arrowSize
            );
            if (poly) svgArrows.push(poly);
          }
        });

        const isMerge = commit.parents.length > 1;
        const isHead = commit.headBranches.length > 0;
        if (isHead) {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="6.8" fill="none" stroke="${commitColor}" stroke-width="1.3" stroke-opacity="0.7" />`
          );
        }
        if (isMerge) {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="4.3" fill="#040805" stroke="${commitColor}" stroke-width="2" />`,
            `<circle cx="${x1}" cy="${y1}" r="1.5" fill="${commitColor}" />`
          );
        } else {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="3.8" fill="${commitColor}" stroke="#040805" stroke-width="1.4" />`
          );
        }
      });
    } else {
      const colWidths = selected.map((name) => MGG.getBranchWidth(name));
      const colStarts = [];
      let acc = 0;
      for (let i = 0; i < colWidths.length; i++) {
        colStarts.push(acc);
        acc += colWidths[i];
      }
      graphWidth = acc;

      colHeadersHtml = selected
        .map((branchName, idx) => {
          const color = MGG.getBranchColor(idx);
          const w = colWidths[idx];
          const displayLabel = MGG.formatBranchHeaderLabel(branchName);
          return `
            <div
              class="mgg-col-header"
              draggable="true"
              data-mgg-ctx="1"
              data-branch="${MGG.escapeHtml(branchName)}"
              style="width:${w}px; color:${color};"
              title="${MGG.escapeHtml(
                branchName
              )} (Arrastra para mover | Borde derecho para redimensionar | Clic derecho para opciones)"
            >
              <span class="mgg-color-dot" style="background:${color}; box-shadow:0 0 6px ${color};"></span>
              <span class="mgg-col-header-label">${MGG.escapeHtml(displayLabel)}</span>
              <span class="mgg-col-resizer mgg-branch-col-resizer" data-branch="${MGG.escapeHtml(
                branchName
              )}" title="Arrastra para redimensionar (doble clic restablece)"></span>
            </div>
          `;
        })
        .join('');

      const getColBaseX = (colIdx) => {
        const idx = Math.max(0, Math.min(selected.length - 1, colIdx));
        return colStarts[idx] + Math.round(colWidths[idx] / 2) - 6;
      };

      const getCommitX = (commit) => {
        const idx = Math.max(0, Math.min(selected.length - 1, commit.colIndex));
        const baseX = getColBaseX(idx);
        if (commit.subLane > 0) {
          const offset = Math.min(CONSTANTS.SUB_LANE_STEP, Math.max(9, Math.floor(colWidths[idx] * 0.24)));
          return baseX + offset;
        }
        return baseX;
      };

      const getCommitColor = (commit) =>
        commit.subLane > 0 ? '#ffea00' : MGG.getBranchColor(commit.colIndex);

      svgRails = selected
        .map((_, idx) => {
          const x = getColBaseX(idx);
          const color = MGG.getBranchColor(idx);
          return `<line x1="${x}" y1="0" x2="${x}" y2="${totalHeight}" stroke="${color}" stroke-opacity="0.14" stroke-width="1" stroke-dasharray="2 5" />`;
        })
        .join('');

      const activeDetoursByCol = new Map();

      function allocateDetourSlot(colIdx, startRow, endRow) {
        if (!activeDetoursByCol.has(colIdx)) activeDetoursByCol.set(colIdx, []);
        const list = activeDetoursByCol.get(colIdx).filter((d) => d.endRow > startRow);
        let slot = 1;
        while (list.some((d) => d.slot === slot)) slot++;
        list.push({ endRow, slot });
        activeDetoursByCol.set(colIdx, list);
        return slot;
      }

      commits.forEach((commit, rowIdx) => {
        const x1 = getCommitX(commit);
        const y1 = rowIdx * ROW_HEIGHT + ROW_HEIGHT / 2;
        const commitColor = getCommitColor(commit);
        const stopDist = getTargetNodeStopDist(commit);

        commit.parents.forEach((parentSha, pIdx) => {
          const parentRow = rowIndexBySha.get(parentSha);
          if (parentRow === undefined) {
            const endY = Math.min(totalHeight, y1 + ROW_HEIGHT * 0.45);
            svgPaths.push(
              `<line class="mgg-edge" data-from="${commit.sha}" data-to="${parentSha}" x1="${x1}" y1="${y1}" x2="${x1}" y2="${endY}" stroke="${commitColor}" style="color:${commitColor};" stroke-width="1.9" stroke-opacity="0.35" stroke-dasharray="2 3" />`
            );
            return;
          }

          const parentCommit = commits[parentRow];
          const x2 = getCommitX(parentCommit);
          const y2 = parentRow * ROW_HEIGHT + ROW_HEIGHT / 2;
          const parentColor = getCommitColor(parentCommit);
          const isMergeEdge = pIdx > 0;
          const isCrossCol = Math.abs(x1 - x2) >= 2;
          let edgeColor = isMergeEdge ? parentColor : commitColor;
          let isIntegrationEdge = isMergeEdge || isCrossCol;

          let d;
          let arrowFromX = x2;
          let arrowFromY = y2;
          let midArrowSeg = null;

          if (!isCrossCol) {
            const blocked = hasIntermediateNodeAtX(commits, rowIdx, parentRow, x1, getCommitX);
            if (!blocked) {
              d = `M ${x2} ${y2} L ${x1} ${y1}`;
              arrowFromX = x1;
              arrowFromY = y2;
            } else {
              isIntegrationEdge = true;
              const slot = allocateDetourSlot(commit.colIndex, rowIdx, parentRow);
              const maxRight = colStarts[commit.colIndex] + colWidths[commit.colIndex] - 6;
              const detourX = Math.min(maxRight, x1 + slot * CONSTANTS.SUB_LANE_STEP);
              if (isMergeEdge) edgeColor = '#ffea00';
              d = buildFlowDetourPath(x2, y2, x1, y1, detourX);
              arrowFromX = detourX;
              arrowFromY = y1;
            }
          } else if (isMergeEdge) {
            const srcColBlocked = hasIntermediateNodeAtX(commits, rowIdx, parentRow, x2, getCommitX);
            if (!srcColBlocked) {
              d = buildMergeFlowPath(x2, y2, x1, y1);
              arrowFromX = x2;
              arrowFromY = y1;
              midArrowSeg = [x2, y1, x1, y1];
            } else {
              const slot = allocateDetourSlot(parentCommit.colIndex, rowIdx, parentRow);
              const dirSide = x1 < x2 ? -1 : 1;
              const minLeft = colStarts[parentCommit.colIndex] + 6;
              const maxRight = colStarts[parentCommit.colIndex] + colWidths[parentCommit.colIndex] - 6;
              const detourX = Math.max(
                minLeft,
                Math.min(maxRight, x2 + dirSide * slot * CONSTANTS.SUB_LANE_STEP)
              );
              d = buildFlowDetourPath(x2, y2, x1, y1, detourX);
              arrowFromX = detourX;
              arrowFromY = y1;
              midArrowSeg = [detourX, y1, x1, y1];
            }
          } else {
            const dstColBlocked = hasIntermediateNodeAtX(commits, rowIdx, parentRow, x1, getCommitX);
            if (!dstColBlocked) {
              d = buildBranchFlowPath(x2, y2, x1, y1);
              arrowFromX = x1;
              arrowFromY = y2;
              midArrowSeg = [x2, y2, x1, y2];
            } else {
              const slot = allocateDetourSlot(commit.colIndex, rowIdx, parentRow);
              const dirSide = x2 < x1 ? -1 : 1;
              const minLeft = colStarts[commit.colIndex] + 6;
              const maxRight = colStarts[commit.colIndex] + colWidths[commit.colIndex] - 6;
              const detourX = Math.max(
                minLeft,
                Math.min(maxRight, x1 + dirSide * slot * CONSTANTS.SUB_LANE_STEP)
              );
              d = buildFlowDetourPath(x2, y2, x1, y1, detourX);
              arrowFromX = detourX;
              arrowFromY = y1;
              midArrowSeg = [x2, y2, detourX, y2];
            }
          }

          if (isCrossCol || d.includes('Q')) {
            svgUnderlays.push(
              `<path d="${d}" fill="none" stroke="#040805" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round" />`
            );
          }

          svgPaths.push(
            `<path class="mgg-edge" data-from="${commit.sha}" data-to="${parentSha}" d="${d}" fill="none" stroke="${edgeColor}" style="color:${edgeColor};" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`
          );

          if (shouldDrawArrow(isIntegrationEdge)) {
            const arrowSize = isIntegrationEdge ? 6.6 : 5.2;
            const poly = buildArrowPolygon(
              arrowFromX,
              arrowFromY,
              x1,
              y1,
              stopDist,
              edgeColor,
              commit.sha,
              parentSha,
              arrowSize
            );
            if (poly) svgArrows.push(poly);

            if (midArrowSeg) {
              const midPoly = buildMidpointArrow(
                midArrowSeg[0],
                midArrowSeg[1],
                midArrowSeg[2],
                midArrowSeg[3],
                edgeColor,
                commit.sha,
                parentSha,
                5.4
              );
              if (midPoly) svgArrows.push(midPoly);
            }
          }
        });

        const isMerge = commit.parents.length > 1;
        const isHead = commit.headBranches.length > 0;

        if (isHead) {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="7.2" fill="none" stroke="${commitColor}" stroke-width="1.3" stroke-opacity="0.7" />`
          );
        }

        if (isMerge) {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="4.6" fill="#040805" stroke="${commitColor}" stroke-width="2.1" />`,
            `<circle cx="${x1}" cy="${y1}" r="1.6" fill="${commitColor}" />`
          );
        } else {
          svgNodes.push(
            `<circle cx="${x1}" cy="${y1}" r="3.9" fill="${commitColor}" stroke="#040805" stroke-width="1.5" />`
          );
        }
      });
    }

    const metaHeadersHtml = state.metaColumnOrder
      .map((metaKey) => {
        const alignStyle =
          metaKey === 'sha'
            ? 'justify-content:center;'
            : metaKey === 'date'
              ? 'justify-content:flex-end;'
              : 'justify-content:flex-start;';
        return `
          <div
            class="mgg-meta-col-head"
            draggable="true"
            data-meta-col="${metaKey}"
            style="${getMetaCellStyle(metaKey)} ${alignStyle}"
            title="Arrastra para mover columna | Arrastra el borde derecho para redimensionar (doble clic restablece)"
          >
            <span>${MGG.escapeHtml(CONSTANTS.META_COL_LABELS[metaKey])}</span>
            <span class="mgg-col-resizer mgg-meta-resizer" data-meta="${metaKey}" title="Redimensionar (doble clic restablece)"></span>
          </div>
        `;
      })
      .join('');

    const rowsHtml = commits
      .map((commit) => {
        const branchPills = commit.headBranches
          .map((bName) => {
            const idx = selected.indexOf(bName);
            const color = MGG.getBranchColor(Math.max(0, idx));
            const label = MGG.formatBranchHeaderLabel(bName);
            return `<span class="mgg-head-pill" data-mgg-ctx="1" data-pill-branch="${MGG.escapeHtml(
              bName
            )}" title="${MGG.escapeHtml(bName)} (Clic derecho para opciones)" style="color:${color}; border-color:${color};">${MGG.escapeHtml(
              label
            )}</span>`;
          })
          .join('');

        const tagPills = state.showTags
          ? MGG.getTagsForSha(commit.sha)
              .map(
                (tName) =>
                  `<span class="mgg-tag-pill" data-mgg-ctx="1" data-pill-tag="${MGG.escapeHtml(
                    tName
                  )}" data-pill-sha="${MGG.escapeHtml(commit.sha)}" title="Tag: ${MGG.escapeHtml(
                    tName
                  )} (Clic derecho para opciones / eliminar)">🏷 ${MGG.escapeHtml(tName)}</span>`
              )
              .join('')
          : '';

        const mergeBadge =
          commit.parents.length > 1 ? '<span class="mgg-merge-tag">MERGE</span>' : '';

        const metaCellsHtml = state.metaColumnOrder
          .map((metaKey) => {
            const style = getMetaCellStyle(metaKey);
            if (metaKey === 'msg') {
              return `
                <div class="mgg-meta-cell mgg-cell-msg" style="${style}">
                  ${branchPills}
                  ${tagPills}
                  ${mergeBadge}
                  <span class="mgg-msg-text" title="${MGG.escapeHtml(
                    commit.subject
                  )} (Clic: ver archivos | Ctrl+Clic / Shift+Clic: selección múltiple | Doble clic: Explorador)">${MGG.escapeHtml(
                commit.subject
              )}</span>
                </div>
              `;
            }
            if (metaKey === 'sha') {
              return `<div class="mgg-meta-cell mgg-cell-sha" style="${style}">${MGG.escapeHtml(
                commit.shortSha
              )}</div>`;
            }
            if (metaKey === 'author') {
              return `<div class="mgg-meta-cell mgg-cell-author" style="${style}" title="${MGG.escapeHtml(
                commit.author
              )}">${MGG.escapeHtml(commit.author)}</div>`;
            }
            return `<div class="mgg-meta-cell mgg-cell-date" style="${style}">${MGG.escapeHtml(
              MGG.formatDate(commit.date)
            )}</div>`;
          })
          .join('');

        const isActiveRow = state.activeSha === commit.sha ? 'mgg-row-active' : '';
        const isMultiRow = state.selectedShas.has(commit.sha) ? 'mgg-row-multi' : '';

        return `
          <div class="mgg-commit-row ${isActiveRow} ${isMultiRow}" data-mgg-ctx="1" data-sha="${MGG.escapeHtml(
          commit.sha
        )}" style="height:${ROW_HEIGHT}px;">
            <div class="mgg-graph-spacer" style="width:${graphWidth}px;"></div>
            <div class="mgg-row-meta">
              ${metaCellsHtml}
            </div>
          </div>
        `;
      })
      .join('');

    graphScroll.innerHTML = `
      <div class="mgg-canvas-wrapper">
        <div class="mgg-grid-header">
          <div class="mgg-branch-cols-header" style="width:${graphWidth}px;">
            ${colHeadersHtml}
          </div>
          <div class="mgg-meta-headers">
            ${metaHeadersHtml}
          </div>
        </div>
        <div class="mgg-rows-container" style="min-height:${totalHeight}px;">
          <svg
            class="mgg-svg-layer"
            width="${graphWidth}"
            height="${totalHeight}"
            viewBox="0 0 ${graphWidth} ${totalHeight}"
          >
            ${svgRails}
            <g class="mgg-underlay-group">${svgUnderlays.join('')}</g>
            <g class="mgg-edges-group">${svgPaths.join('')}</g>
            <g class="mgg-arrows-group">${svgArrows.join('')}</g>
            <g class="mgg-nodes-group">${svgNodes.join('')}</g>
          </svg>
          ${rowsHtml}
        </div>
      </div>
    `;

    graphScroll.scrollLeft = prevScrollLeft;
    graphScroll.scrollTop = prevScrollTop;

    bindColumnInteractions(graphScroll, selected);

    const svgEl = graphScroll.querySelector('.mgg-svg-layer');
    const edgeIndex = new Map();
    if (svgEl) {
      svgEl.querySelectorAll('.mgg-edge').forEach((el) => {
        const from = el.getAttribute('data-from');
        const to = el.getAttribute('data-to');
        if (from) {
          if (!edgeIndex.has(from)) edgeIndex.set(from, []);
          edgeIndex.get(from).push(el);
        }
        if (to) {
          if (!edgeIndex.has(to)) edgeIndex.set(to, []);
          edgeIndex.get(to).push(el);
        }
      });
    }

    let highlightedEdges = [];

    graphScroll.querySelectorAll('.mgg-commit-row').forEach((row) => {
      const sha = row.getAttribute('data-sha');

      row.addEventListener('mouseenter', () => {
        if (!svgEl) return;
        highlightedEdges.forEach((el) => el.classList.remove('mgg-edge-hot'));
        highlightedEdges = edgeIndex.get(sha) || [];
        if (highlightedEdges.length > 0) {
          svgEl.classList.add('mgg-hovering');
          highlightedEdges.forEach((el) => el.classList.add('mgg-edge-hot'));
        }
      });

      row.addEventListener('mouseleave', () => {
        if (!svgEl) return;
        svgEl.classList.remove('mgg-hovering');
        highlightedEdges.forEach((el) => el.classList.remove('mgg-edge-hot'));
        highlightedEdges = [];
      });

      row.addEventListener('click', (e) => {
        handleCommitRowClick(e, sha);
      });

      row.addEventListener('dblclick', () => {
        const commit = state.commitMap.get(sha);
        if (commit) MGG.explorer.openForCommit(commit);
      });

      row.addEventListener('contextmenu', (e) => {
        const tagPill = e.target.closest('.mgg-tag-pill[data-pill-tag]');
        if (tagPill) {
          openTagContextMenu(
            e,
            tagPill.getAttribute('data-pill-tag'),
            tagPill.getAttribute('data-pill-sha')
          );
          return;
        }
        const branchPill = e.target.closest('.mgg-head-pill[data-pill-branch]');
        if (branchPill) {
          openBranchContextMenu(e, branchPill.getAttribute('data-pill-branch'));
          return;
        }
        const commit = state.commitMap.get(sha);
        if (commit) {
          if (!state.selectedShas.has(sha)) {
            state.lastAnchorSha = sha;
            applySelection([sha], sha, { pushHistory: true });
          }
          openCommitContextMenu(e, commit);
        }
      });
    });
  }

  // =====================================================================
  // PANEL INFERIOR: IZQUIERDA (DESCRIPCIÓN + ARCHIVOS) | DERECHA (DIFF INLINE)
  // SOPORTA 1 COMMIT O SELECCIÓN MÚLTIPLE DE COMMITS
  // =====================================================================

  function bindDetailPanelResizers(panel) {
    const topHandle = panel.querySelector('.mgg-detail-resizer');
    if (topHandle) {
      topHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = panel.getBoundingClientRect().height;
        topHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select-row');

        const onMove = (ev) => {
          const maxH = Math.round(window.innerHeight * 0.78);
          const nextH = Math.min(maxH, Math.max(150, Math.round(startH - (ev.clientY - startY))));
          state.detailHeight = nextH;
          panel.style.height = `${nextH}px`;
        };
        const onUp = () => {
          topHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select-row');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      topHandle.addEventListener('dblclick', () => {
        state.detailHeight = 290;
        panel.style.height = '290px';
        MGG.saveCurrentRepoConfig();
      });
    }

    const leftPane = panel.querySelector('.mgg-detail-left');
    const vHandle = panel.querySelector('.mgg-detail-v-resizer');
    if (leftPane && vHandle) {
      leftPane.style.width = `${state.detailLeftWidth}px`;
      vHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = leftPane.getBoundingClientRect().width;
        vHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select');

        const onMove = (ev) => {
          const maxW = Math.round(panel.getBoundingClientRect().width * 0.75);
          const nextW = Math.min(maxW, Math.max(180, Math.round(startW + (ev.clientX - startX))));
          state.detailLeftWidth = nextW;
          leftPane.style.width = `${nextW}px`;
        };
        const onUp = () => {
          vHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      vHandle.addEventListener('dblclick', () => {
        state.detailLeftWidth = 350;
        leftPane.style.width = '350px';
        MGG.saveCurrentRepoConfig();
      });
    }

    const msgEl = panel.querySelector('.mgg-detail-msg');
    const msgHandle = panel.querySelector('.mgg-detail-msg-resizer');
    if (msgEl && msgHandle) {
      msgEl.style.height = `${state.detailMsgHeight}px`;
      msgHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = msgEl.getBoundingClientRect().height;
        msgHandle.classList.add('mgg-resizing');
        document.body.classList.add('mgg-no-select-row');

        const onMove = (ev) => {
          const nextH = Math.min(360, Math.max(34, Math.round(startH + (ev.clientY - startY))));
          state.detailMsgHeight = nextH;
          msgEl.style.height = `${nextH}px`;
        };
        const onUp = () => {
          msgHandle.classList.remove('mgg-resizing');
          document.body.classList.remove('mgg-no-select-row');
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          MGG.saveCurrentRepoConfig();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      msgHandle.addEventListener('dblclick', () => {
        state.detailMsgHeight = 72;
        msgEl.style.height = '72px';
        MGG.saveCurrentRepoConfig();
      });
    }
  }

  function renderInlineFilesList(panel) {
    const listEl = panel.querySelector('#mgg-detail-files-list');
    if (!listEl) return;

    const q = detailState.fileFilter;
    const entries = detailState.files
      .map((file, idx) => ({ file, idx }))
      .filter(({ file }) => !q || file.filename.toLowerCase().includes(q));

    if (entries.length === 0) {
      listEl.innerHTML =
        '<div style="font-size:11px; color:#55bd6d; padding:8px;">Sin archivos coincidentes</div>';
      return;
    }

    const isMulti = detailState.commits.length > 1;

    listEl.innerHTML = entries
      .map(({ file, idx }) => {
        const isActive = idx === detailState.selectedFileIdx;
        const lastSlash = file.filename.lastIndexOf('/');
        const baseName = lastSlash !== -1 ? file.filename.slice(lastSlash + 1) : file.filename;
        const dirName = lastSlash !== -1 ? file.filename.slice(0, lastSlash) : '';
        const status = file.status || 'M';
        const multiCountBadge =
          isMulti && file.entries.length > 1
            ? `<span class="mgg-file-commit-count" title="Tocado en ${file.entries.length} commits">×${file.entries.length}</span>`
            : '';

        return `
          <div class="mgg-exp-file-item ${
            isActive ? 'mgg-file-active' : ''
          }" data-mgg-ctx="1" data-inline-file-idx="${idx}" title="${MGG.escapeHtml(
          file.filename
        )} (Clic para ver diff | Doble clic para pantalla completa | Clic derecho para opciones)">
            <span class="mgg-file-status mgg-st-${MGG.escapeHtml(status)}">${MGG.escapeHtml(
          status
        )}</span>
            <div class="mgg-file-name-wrap">
              <span class="mgg-file-base">${MGG.escapeHtml(baseName)}</span>
              ${dirName ? `<span class="mgg-file-dir">${MGG.escapeHtml(dirName)}</span>` : ''}
            </div>
            ${multiCountBadge}
            <div class="mgg-file-nums">
              ${file.additions ? `<span class="mgg-stat-add">+${file.additions}</span>` : ''}
              ${file.deletions ? `<span class="mgg-stat-del">-${file.deletions}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('[data-inline-file-idx]').forEach((row) => {
      const idx = Number(row.getAttribute('data-inline-file-idx'));

      row.addEventListener('click', () => {
        if (Number.isNaN(idx)) return;
        detailState.selectedFileIdx = idx;
        renderInlineFilesList(panel);
        renderInlineFileDiff(panel);
      });

      row.addEventListener('dblclick', () => {
        const file = detailState.files[idx];
        const primaryCommit = file?.entries?.[0]?.commit || detailState.commits[0];
        if (file && primaryCommit) MGG.explorer.openForCommit(primaryCommit, file.filename);
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = detailState.files[idx];
        if (!file) return;
        detailState.selectedFileIdx = idx;
        renderInlineFilesList(panel);
        renderInlineFileDiff(panel);
        const primaryCommit = file.entries?.[0]?.commit || detailState.commits[0];

        MGG.explorer.openContextMenu(e.clientX, e.clientY, `Archivo: ${file.filename}`, [
          {
            icon: '📂',
            label: 'Abrir en Explorador completo',
            onClick: () => {
              if (primaryCommit) MGG.explorer.openForCommit(primaryCommit, file.filename);
            }
          },
          {
            icon: '📋',
            label: 'Copiar ruta del archivo',
            onClick: () => {
              navigator.clipboard?.writeText(file.filename);
              setStatus(`Ruta copiada: ${file.filename}`);
            }
          },
          {
            icon: '↗',
            label: 'Ver archivo en GitHub',
            onClick: () => {
              if (file.blobUrl) window.open(file.blobUrl, '_blank', 'noopener,noreferrer');
            }
          }
        ]);
      });
    });
  }

  function renderInlineFileDiff(panel) {
    const pathEl = panel.querySelector('#mgg-detail-diff-path');
    const viewerEl = panel.querySelector('#mgg-detail-diff-viewer');
    const blobLink = panel.querySelector('#mgg-detail-blob-link');
    const splitBtn = panel.querySelector('#mgg-detail-view-split');
    const unifiedBtn = panel.querySelector('#mgg-detail-view-unified');

    if (splitBtn) splitBtn.classList.toggle('mgg-tab-active', state.diffViewMode === 'split');
    if (unifiedBtn) unifiedBtn.classList.toggle('mgg-tab-active', state.diffViewMode === 'unified');

    const file = detailState.files[detailState.selectedFileIdx];
    if (!file) {
      if (pathEl) pathEl.textContent = 'Sin archivos modificados';
      if (blobLink) blobLink.style.display = 'none';
      if (viewerEl) {
        viewerEl.innerHTML =
          '<div class="mgg-empty-state" style="padding:20px;">No hay cambios de archivo visibles en la selección actual.</div>';
      }
      return;
    }

    const label = file.previousFilename
      ? `${file.previousFilename} → ${file.filename}`
      : file.filename;
    if (pathEl) {
      pathEl.textContent = label;
      pathEl.title = label;
    }
    if (blobLink) {
      blobLink.style.display = 'inline-flex';
      blobLink.href = file.blobUrl || '#';
    }

    // Modo 1 commit
    if (detailState.commits.length <= 1) {
      const entry = file.entries[0];
      const patch = entry?.file?.patch || '';
      if (!patch) {
        viewerEl.innerHTML = `
          <div class="mgg-empty-state" style="padding:18px;">
            Sin diff de texto para <strong>${MGG.escapeHtml(file.filename)}</strong> (archivo binario o sin cambios de contenido).
          </div>
        `;
        return;
      }
      viewerEl.innerHTML = MGG.explorer.renderDiffHtml(patch, state.diffViewMode);
      viewerEl.scrollTop = 0;
      return;
    }

    // Modo selección múltiple: renderizar los cambios de cada commit que tocó este archivo
    const sectionsHtml = file.entries
      .map(({ commit, file: cFile }, eIdx) => {
        const diffBlock = cFile.patch
          ? MGG.explorer.renderDiffHtml(cFile.patch, state.diffViewMode)
          : '<div class="mgg-empty-state" style="padding:12px;">Sin diff de texto en este commit (archivo binario o renombrado).</div>';

        return `
          <div class="mgg-multi-commit-banner">
            <div class="mgg-multi-commit-banner-meta">
              <span class="mgg-detail-sha">${MGG.escapeHtml(commit.shortSha)}</span>
              <span>${MGG.escapeHtml(commit.subject)}</span>
              <span style="color:#65b878;">(${MGG.escapeHtml(commit.author)} · ${MGG.escapeHtml(
          MGG.formatDate(commit.date)
        )})</span>
            </div>
            <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
              <span class="mgg-stat-add">+${cFile.additions || 0}</span>
              <span class="mgg-stat-del">-${cFile.deletions || 0}</span>
              <button type="button" class="mgg-btn mgg-btn-sm mgg-open-entry-exp" data-entry-idx="${eIdx}">Abrir ↗</button>
            </div>
          </div>
          ${diffBlock}
        `;
      })
      .join('');

    viewerEl.innerHTML = sectionsHtml;
    viewerEl.scrollTop = 0;

    viewerEl.querySelectorAll('.mgg-open-entry-exp').forEach((btn) => {
      btn.addEventListener('click', () => {
        const eIdx = Number(btn.getAttribute('data-entry-idx'));
        const entry = file.entries[eIdx];
        if (entry?.commit) MGG.explorer.openForCommit(entry.commit, file.filename);
      });
    });
  }

  async function showSelectionDetails() {
    const panel = ui.overlay.querySelector('#mgg-detail-panel');
    if (!state.repo) {
      panel.classList.remove('mgg-visible');
      return;
    }

    // Ordenar commits seleccionados siguiendo el orden del grafo (más reciente primero)
    const selectedCommits = state.orderedCommits.filter((c) => state.selectedShas.has(c.sha));
    if (selectedCommits.length === 0) {
      panel.classList.remove('mgg-visible');
      return;
    }

    const { owner, repo } = state.repo;
    const isMulti = selectedCommits.length > 1;
    const primaryCommit =
      (state.activeSha && state.commitMap.get(state.activeSha)) || selectedCommits[0];
    const selectionKey = selectedCommits.map((c) => c.sha).join(',');

    detailState.selectionKey = selectionKey;
    detailState.commits = selectedCommits;
    detailState.files = [];
    detailState.selectedFileIdx = 0;
    detailState.fileFilter = '';

    let topMetaHtml = '';
    let topActionsHtml = '';
    let descriptionText = '';

    if (!isMulti) {
      const commit = primaryCommit;
      const parentsText =
        commit.parents.length > 0
          ? commit.parents.map((p) => p.slice(0, 7)).join(', ')
          : 'Raíz (sin padres)';
      const branchesText = Array.from(commit.branches || []).join(', ');
      const tags = MGG.getTagsForSha(commit.sha);
      const tagsHtml =
        tags.length > 0
          ? tags
              .map(
                (t) =>
                  `<span class="mgg-tag-pill" data-mgg-ctx="1" data-pill-tag="${MGG.escapeHtml(
                    t
                  )}" data-pill-sha="${MGG.escapeHtml(
                    commit.sha
                  )}" title="Tag: ${MGG.escapeHtml(t)} (Clic derecho para eliminar)">🏷 ${MGG.escapeHtml(
                    t
                  )}</span>`
              )
              .join('')
          : '';
      const prNum = MGG.extractPrNumberFromMessage(commit.message);
      const prRevertLabel = prNum ? `↺ Revert PR #${prNum}` : '↺ PR Revert';
      const suggestedHeadBranch =
        commit.headBranches?.[0] || Array.from(commit.branches || [])[0] || '';

      topMetaHtml = `
        <span class="mgg-detail-sha">${MGG.escapeHtml(commit.shortSha)}</span>
        ${tagsHtml}
        <span style="color:#65b878;">Padres (${commit.parents.length}): ${MGG.escapeHtml(
        parentsText
      )}</span>
        <span style="color:#65b878;">Autor: ${MGG.escapeHtml(commit.author)} (${MGG.escapeHtml(
        MGG.formatDate(commit.date)
      )})</span>
        <span style="color:#00f0ff;">Ramas: ${MGG.escapeHtml(branchesText)}</span>
      `;

      topActionsHtml = `
        <button type="button" id="mgg-open-explorer-btn" class="mgg-btn mgg-btn-sm">📂 Pantalla completa</button>
        <button type="button" id="mgg-detail-create-pr-btn" class="mgg-btn mgg-btn-sm mgg-btn-cyan" title="Crear Pull Request desde ${MGG.escapeHtml(
          suggestedHeadBranch || 'una rama'
        )}">🔀 Crear PR</button>
        <button type="button" id="mgg-create-tag-btn" class="mgg-btn mgg-btn-sm mgg-btn-tag">🏷 Crear Tag</button>
        <button type="button" id="mgg-pr-revert-btn" class="mgg-btn mgg-btn-sm mgg-btn-cyan">${MGG.escapeHtml(
          prRevertLabel
        )}</button>
        <button type="button" id="mgg-copy-sha" class="mgg-btn mgg-btn-sm">Copiar SHA</button>
        <a href="${MGG.escapeHtml(
          commit.htmlUrl
        )}" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">GitHub ↗</a>
      `;

      descriptionText = commit.message;
    } else {
      const authors = Array.from(new Set(selectedCommits.map((c) => c.author)));
      const authorsText =
        authors.length <= 3 ? authors.join(', ') : `${authors.slice(0, 3).join(', ')} +${authors.length - 3}`;

      topMetaHtml = `
        <span class="mgg-multi-badge">${selectedCommits.length} COMMITS SELECCIONADOS</span>
        <span style="color:#65b878;">Autores: ${MGG.escapeHtml(authorsText)}</span>
        <span style="color:#00f0ff;">Rango: ${MGG.escapeHtml(
          selectedCommits[selectedCommits.length - 1].shortSha
        )} … ${MGG.escapeHtml(selectedCommits[0].shortSha)}</span>
      `;

      topActionsHtml = `
        <button type="button" id="mgg-open-explorer-btn" class="mgg-btn mgg-btn-sm">📂 Explorar activo</button>
        <button type="button" id="mgg-copy-sha" class="mgg-btn mgg-btn-sm">Copiar SHAs (${selectedCommits.length})</button>
        <button type="button" id="mgg-clear-multi-btn" class="mgg-btn mgg-btn-sm mgg-btn-close">✕ Limpiar selección</button>
      `;

      descriptionText = selectedCommits
        .map((c) => `• ${c.shortSha} | ${c.author} (${MGG.formatDate(c.date)})\n  ${c.subject}`)
        .join('\n');
    }

    panel.style.height = `${state.detailHeight}px`;
    panel.innerHTML = `
      <div class="mgg-detail-resizer" title="Arrastra para redimensionar panel de detalle (doble clic restablece)"></div>
      <div class="mgg-detail-top">
        <div class="mgg-detail-meta">${topMetaHtml}</div>
        <div class="mgg-detail-actions">${topActionsHtml}</div>
      </div>

      <div class="mgg-detail-body">
        <div class="mgg-detail-left">
          <pre class="mgg-detail-msg">${MGG.escapeHtml(descriptionText)}</pre>
          <div class="mgg-detail-msg-resizer" title="Arrastra para redimensionar descripción vs lista de archivos"></div>
          <div class="mgg-detail-files-head">
            <span>${isMulti ? 'ARCHIVOS COMBINADOS' : 'ARCHIVOS MODIFICADOS'}</span>
            <span id="mgg-detail-files-stats" style="color:#00f0ff;">Cargando...</span>
          </div>
          <input
            type="text"
            id="mgg-detail-files-filter"
            class="mgg-input mgg-detail-files-filter"
            placeholder="Filtrar archivos..."
          />
          <div id="mgg-detail-files-list" class="mgg-detail-files-list">
            <div style="font-size:11px; color:#55bd6d; padding:8px;">Cargando archivos modificados (${selectedCommits.length} commit${
      isMulti ? 's' : ''
    })...</div>
          </div>
        </div>

        <div class="mgg-detail-v-resizer" title="Arrastra para redimensionar izquierda (30%) vs derecha (70%) — Doble clic restablece"></div>

        <div class="mgg-detail-right">
          <div class="mgg-detail-diff-bar">
            <span id="mgg-detail-diff-path" class="mgg-detail-diff-path">Cargando cambios...</span>
            <div class="mgg-detail-diff-controls">
              <button type="button" id="mgg-detail-view-split" class="mgg-tab-btn">Split</button>
              <button type="button" id="mgg-detail-view-unified" class="mgg-tab-btn">Unificado</button>
              <button type="button" id="mgg-detail-file-history-btn" class="mgg-btn mgg-btn-sm" title="Abrir historial completo de este archivo">🕒 Historial</button>
              <a id="mgg-detail-blob-link" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm" style="display:none;">Archivo ↗</a>
            </div>
          </div>
          <div id="mgg-detail-diff-viewer" class="mgg-detail-diff-viewer">
            <div class="mgg-empty-state" style="padding:20px;">Leyendo diff de la selección...</div>
          </div>
        </div>
      </div>
    `;

    panel.classList.add('mgg-visible');
    bindDetailPanelResizers(panel);

    panel.querySelectorAll('.mgg-tag-pill[data-pill-tag]').forEach((pill) => {
      pill.addEventListener('contextmenu', (e) => {
        openTagContextMenu(e, pill.getAttribute('data-pill-tag'), pill.getAttribute('data-pill-sha'));
      });
    });

    panel.querySelector('#mgg-open-explorer-btn')?.addEventListener('click', () => {
      const currentFile = detailState.files[detailState.selectedFileIdx];
      const targetCommit = currentFile?.entries?.[0]?.commit || primaryCommit;
      MGG.explorer.openForCommit(targetCommit, currentFile?.filename || '');
    });

    if (!isMulti) {
      const suggestedHeadBranch =
        primaryCommit.headBranches?.[0] || Array.from(primaryCommit.branches || [])[0] || '';
      const prNum = MGG.extractPrNumberFromMessage(primaryCommit.message);

      panel.querySelector('#mgg-detail-create-pr-btn')?.addEventListener('click', () => {
        MGG.explorer.openCreatePrDialog({ head: suggestedHeadBranch });
      });

      panel.querySelector('#mgg-create-tag-btn')?.addEventListener('click', () => {
        MGG.explorer.openCreateTagDialog(primaryCommit);
      });

      panel.querySelector('#mgg-pr-revert-btn')?.addEventListener('click', () => {
        MGG.explorer.openPrRevertDialog(primaryCommit, prNum);
      });
    } else {
      panel.querySelector('#mgg-clear-multi-btn')?.addEventListener('click', clearNavigationAndSelection);
    }

    panel.querySelector('#mgg-copy-sha')?.addEventListener('click', (e) => {
      const textToCopy = isMulti
        ? selectedCommits.map((c) => c.sha).join('\n')
        : primaryCommit.sha;
      navigator.clipboard?.writeText(textToCopy);
      const prevTxt = e.target.textContent;
      e.target.textContent = '¡Copiado!';
      setTimeout(() => {
        e.target.textContent = prevTxt;
      }, 1200);
    });

    panel.querySelector('#mgg-detail-files-filter')?.addEventListener('input', (e) => {
      detailState.fileFilter = e.target.value.toLowerCase();
      renderInlineFilesList(panel);
    });

    panel.querySelector('#mgg-detail-view-split')?.addEventListener('click', () => {
      state.diffViewMode = 'split';
      MGG.saveCurrentRepoConfig();
      renderInlineFileDiff(panel);
    });

    panel.querySelector('#mgg-detail-view-unified')?.addEventListener('click', () => {
      state.diffViewMode = 'unified';
      MGG.saveCurrentRepoConfig();
      renderInlineFileDiff(panel);
    });

    panel.querySelector('#mgg-detail-file-history-btn')?.addEventListener('click', () => {
      const currentFile = detailState.files[detailState.selectedFileIdx];
      const targetCommit = currentFile?.entries?.[0]?.commit || primaryCommit;
      MGG.explorer.openForCommit(targetCommit, currentFile?.filename || '');
    });

    // Descargar diffs de todos los commits seleccionados (en lotes para no saturar)
    const diffResults = [];
    const batchSize = 4;
    for (let i = 0; i < selectedCommits.length; i += batchSize) {
      const batch = selectedCommits.slice(i, i + batchSize);
      const batchRes = await Promise.all(
        batch.map(async (c) => ({
          commit: c,
          res: await MGG.github.fetchCommitDiff(owner, repo, c.sha)
        }))
      );
      if (detailState.selectionKey !== selectionKey) return;
      diffResults.push(...batchRes);
    }

    const aggregatedMap = new Map();
    let totalAdd = 0;
    let totalDel = 0;

    for (const { commit, res } of diffResults) {
      if (!res || !res.ok || !Array.isArray(res.files)) continue;
      for (const f of res.files) {
        totalAdd += f.additions || 0;
        totalDel += f.deletions || 0;

        if (!aggregatedMap.has(f.filename)) {
          aggregatedMap.set(f.filename, {
            filename: f.filename,
            previousFilename: f.previousFilename || '',
            status: f.status || 'M',
            additions: f.additions || 0,
            deletions: f.deletions || 0,
            blobUrl: f.blobUrl || '',
            entries: [{ commit, file: f }]
          });
        } else {
          const agg = aggregatedMap.get(f.filename);
          agg.additions += f.additions || 0;
          agg.deletions += f.deletions || 0;
          agg.entries.push({ commit, file: f });
        }
      }
    }

    detailState.files = Array.from(aggregatedMap.values()).sort((a, b) =>
      a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' })
    );
    detailState.selectedFileIdx = 0;

    const statsEl = panel.querySelector('#mgg-detail-files-stats');
    if (statsEl) {
      statsEl.innerHTML = `<span class="mgg-stat-files">${detailState.files.length}</span> <span class="mgg-stat-add">+${totalAdd}</span> <span class="mgg-stat-del">-${totalDel}</span>`;
    }

    renderInlineFilesList(panel);
    renderInlineFileDiff(panel);
  }

  function showCommitDetails(commit) {
    if (!commit) {
      clearNavigationAndSelection();
      return;
    }
    if (!state.selectedShas.has(commit.sha)) {
      state.selectedShas = new Set([commit.sha]);
    }
    state.activeSha = commit.sha;
    showSelectionDetails();
  }

  function selectAndScrollToSha(sha) {
    if (!sha || !ui.overlay) return false;
    const lower = String(sha).toLowerCase();
    let targetCommit = state.commitMap.get(sha);

    if (!targetCommit) {
      for (const [k, v] of state.commitMap.entries()) {
        if (k.toLowerCase() === lower || k.toLowerCase().startsWith(lower)) {
          targetCommit = v;
          break;
        }
      }
    }

    if (!targetCommit) return false;
    state.lastAnchorSha = targetCommit.sha;
    applySelection([targetCommit.sha], targetCommit.sha, {
      pushHistory: true,
      scrollIntoView: true
    });
    return true;
  }

  // =====================================================================
  // REGISTRO DE CALLBACKS Y DETECCIÓN SPA DE GITHUB
  // =====================================================================

  Object.assign(callbacks, {
    setStatus,
    updateRateDisplay,
    updateControlsUI,
    loadRepoData,
    renderBranchSidebar,
    renderGraph,
    selectAndScrollToSha,
    showCommitDetails
  });

  function syncVisibility() {
    ensureUI();
    const repo = MGG.parseGitHubRepo();
    if (repo) {
      ui.stickyBtn.classList.add('mgg-visible');
      if (state.repo && state.repo.fullName !== repo.fullName) {
        if (ui.overlay.classList.contains('mgg-open')) {
          openModal();
        } else {
          state.repo = null;
          state.branches = [];
          state.tags = [];
          state.tagsBySha.clear();
          state.orderedCommits = [];
          state.commitMap.clear();
          MGG.resetNavigationAndSelection();
        }
      }
    } else {
      ui.stickyBtn.classList.remove('mgg-visible');
      closeModal();
    }
  }

  let lastUrl = location.href;
  document.addEventListener('turbo:load', syncVisibility);
  window.addEventListener('popstate', syncVisibility);
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      syncVisibility();
    }
  }, 600);

  syncVisibility();
})();