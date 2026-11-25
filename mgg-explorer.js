(() => {
  if (window.__MGG_EXPLORER_INIT__) return;
  window.__MGG_EXPLORER_INIT__ = true;

  const MGG = window.MGG;
  const { state, callbacks } = MGG;

  let explorerEl = null;
  let dialogBackdropEl = null;
  let contextMenuEl = null;
  let navStack = [];

  // =====================================================================
  // PARSER Y RENDERIZADOR DE DIFF (SPLIT / MERGE Y UNIFICADO)
  // =====================================================================

  function parsePatchToRows(patch) {
    if (!patch || !patch.trim()) return [];
    const rawLines = patch.split(/\r?\n/);
    const rows = [];
    let oldLine = 0;
    let newLine = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.startsWith('@@')) {
        const m = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/);
        if (m) {
          oldLine = Number(m[1]);
          newLine = Number(m[2]);
        }
        rows.push({ type: 'hunk', text: line });
        continue;
      }

      if (line.startsWith('\\ No newline at end of file')) {
        rows.push({ type: 'meta', text: line });
        continue;
      }

      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === '+') {
        rows.push({ type: 'add', oldNum: '', newNum: newLine++, text: content });
      } else if (prefix === '-') {
        rows.push({ type: 'del', oldNum: oldLine++, newNum: '', text: content });
      } else if (prefix === ' ' || line === '') {
        rows.push({
          type: 'ctx',
          oldNum: oldLine++,
          newNum: newLine++,
          text: prefix === ' ' ? content : ''
        });
      } else {
        rows.push({ type: 'ctx', oldNum: oldLine++, newNum: newLine++, text: line });
      }
    }

    return rows;
  }

  function buildSplitRows(unifiedRows) {
    const split = [];
    let i = 0;

    while (i < unifiedRows.length) {
      const row = unifiedRows[i];

      if (row.type === 'hunk' || row.type === 'meta') {
        split.push({ type: row.type, text: row.text });
        i++;
        continue;
      }

      if (row.type === 'ctx') {
        split.push({
          type: 'pair',
          isChangeStart: false,
          left: { type: 'ctx', num: row.oldNum, text: row.text },
          right: { type: 'ctx', num: row.newNum, text: row.text }
        });
        i++;
        continue;
      }

      const dels = [];
      const adds = [];
      while (i < unifiedRows.length && (unifiedRows[i].type === 'del' || unifiedRows[i].type === 'add')) {
        if (unifiedRows[i].type === 'del') dels.push(unifiedRows[i]);
        else adds.push(unifiedRows[i]);
        i++;
      }

      const maxLen = Math.max(dels.length, adds.length);
      for (let k = 0; k < maxLen; k++) {
        const d = dels[k] || null;
        const a = adds[k] || null;
        split.push({
          type: 'pair',
          isChangeStart: k === 0,
          left: d ? { type: 'del', num: d.oldNum, text: d.text } : { type: 'empty', num: '', text: '' },
          right: a ? { type: 'add', num: a.newNum, text: a.text } : { type: 'empty', num: '', text: '' }
        });
      }
    }

    return split;
  }

  function renderSplitDiffHtml(patch) {
    const unifiedRows = parsePatchToRows(patch);
    const splitRows = buildSplitRows(unifiedRows);
    const bodyHtml = splitRows
      .map((row) => {
        if (row.type === 'hunk') {
          return `<tr class="mgg-diff-hunk"><td colspan="6">${MGG.escapeHtml(row.text)}</td></tr>`;
        }
        if (row.type === 'meta') {
          return `<tr class="mgg-diff-hunk"><td colspan="6" style="color:#65b878;">${MGG.escapeHtml(
            row.text
          )}</td></tr>`;
        }

        const l = row.left;
        const r = row.right;
        const anchorCls = row.isChangeStart ? 'mgg-change-anchor' : '';

        const lLnCls =
          l.type === 'del' ? 'mgg-diff-del-ln' : l.type === 'empty' ? 'mgg-diff-empty' : '';
        const lCodeCls =
          l.type === 'del' ? 'mgg-diff-del' : l.type === 'empty' ? 'mgg-diff-empty' : '';
        const lSign = l.type === 'del' ? '-' : '';

        const rLnCls =
          r.type === 'add' ? 'mgg-diff-add-ln' : r.type === 'empty' ? 'mgg-diff-empty' : '';
        const rCodeCls =
          r.type === 'add' ? 'mgg-diff-add' : r.type === 'empty' ? 'mgg-diff-empty' : '';
        const rSign = r.type === 'add' ? '+' : '';

        return `
          <tr class="${anchorCls}">
            <td class="mgg-diff-ln ${lLnCls}">${l.num}</td>
            <td class="mgg-diff-sign ${lCodeCls}">${lSign}</td>
            <td class="mgg-diff-code mgg-diff-split-sep ${lCodeCls}">${MGG.escapeHtml(
          l.text
        )}</td>
            <td class="mgg-diff-ln ${rLnCls}">${r.num}</td>
            <td class="mgg-diff-sign ${rCodeCls}">${rSign}</td>
            <td class="mgg-diff-code ${rCodeCls}">${MGG.escapeHtml(r.text)}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <table class="mgg-diff-table">
        <thead>
          <tr>
            <th style="width:44px;">#</th>
            <th style="width:18px;"></th>
            <th class="mgg-diff-split-sep">Anterior (Base / Padre)</th>
            <th style="width:44px;">#</th>
            <th style="width:18px;"></th>
            <th>Nuevo (Commit actual)</th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    `;
  }

  function renderUnifiedDiffHtml(patch) {
    const unifiedRows = parsePatchToRows(patch);
    let prevWasChange = false;
    const bodyHtml = unifiedRows
      .map((row) => {
        if (row.type === 'hunk') {
          prevWasChange = false;
          return `<tr class="mgg-diff-hunk"><td colspan="4">${MGG.escapeHtml(row.text)}</td></tr>`;
        }
        if (row.type === 'meta') {
          prevWasChange = false;
          return `<tr class="mgg-diff-hunk"><td colspan="4" style="color:#65b878;">${MGG.escapeHtml(
            row.text
          )}</td></tr>`;
        }

        const isChange = row.type === 'add' || row.type === 'del';
        const anchorCls = isChange && !prevWasChange ? 'mgg-change-anchor' : '';
        prevWasChange = isChange;

        const lnCls =
          row.type === 'add' ? 'mgg-diff-add-ln' : row.type === 'del' ? 'mgg-diff-del-ln' : '';
        const codeCls =
          row.type === 'add' ? 'mgg-diff-add' : row.type === 'del' ? 'mgg-diff-del' : '';
        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';

        return `
          <tr class="${anchorCls}">
            <td class="mgg-diff-ln ${lnCls}">${row.oldNum}</td>
            <td class="mgg-diff-ln ${lnCls}">${row.newNum}</td>
            <td class="mgg-diff-sign ${codeCls}">${sign}</td>
            <td class="mgg-diff-code ${codeCls}">${MGG.escapeHtml(row.text)}</td>
          </tr>
        `;
      })
      .join('');

    return `
      <table class="mgg-diff-table">
        <thead>
          <tr>
            <th style="width:44px;">Ant.</th>
            <th style="width:44px;">Nvo.</th>
            <th style="width:18px;"></th>
            <th>Cambio Unificado</th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    `;
  }

  function renderDiffHtml(patch, mode = state.diffViewMode) {
    return mode === 'unified' ? renderUnifiedDiffHtml(patch) : renderSplitDiffHtml(patch);
  }

  // =====================================================================
  // MENÚ CONTEXTUAL DE CLIC SECUNDARIO (SIEMPRE AL FRENTE)
  // =====================================================================

  function ensureContextMenu() {
    if (contextMenuEl) return;
    contextMenuEl = document.createElement('div');
    contextMenuEl.id = 'mgg-context-menu';
    contextMenuEl.className = 'mgg-ctx-menu';
    contextMenuEl.setAttribute('role', 'menu');
    contextMenuEl.style.display = 'none';
    document.documentElement.appendChild(contextMenuEl);

    document.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (contextMenuEl && contextMenuEl.style.display !== 'none' && !contextMenuEl.contains(e.target)) {
        closeContextMenu();
      }
    });

    contextMenuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function closeContextMenu() {
    if (!contextMenuEl) return;
    contextMenuEl.classList.remove('mgg-open');
    contextMenuEl.style.display = 'none';
    contextMenuEl.innerHTML = '';
  }

  function isContextMenuOpen() {
    return Boolean(contextMenuEl && contextMenuEl.style.display !== 'none');
  }

  function openContextMenu(clientX, clientY, headerTitle, items = []) {
    ensureContextMenu();
    closeContextMenu();

    const validItems = items.filter(Boolean);
    if (validItems.length === 0) return;

    const headerHtml = headerTitle
      ? `<div class="mgg-ctx-header" style="padding:5px 11px 6px 11px;font-size:10px;font-weight:700;color:#55bd6d;border-bottom:1px solid #0d3d18;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${MGG.escapeHtml(headerTitle)}</div>`
      : '';

    const bodyHtml = validItems
      .map((item, idx) => {
        if (item.separator) {
          return '<div class="mgg-ctx-sep" style="height:1px;background:#0d3d18;margin:4px 8px;"></div>';
        }
        const color =
          item.variant === 'cyan'
            ? '#7df9ff'
            : item.variant === 'warn'
              ? '#ffd966'
              : item.variant === 'danger'
                ? '#ff8097'
                : '#c8ffd6';
        const variantCls =
          item.variant === 'cyan'
            ? 'mgg-ctx-cyan'
            : item.variant === 'warn'
              ? 'mgg-ctx-warn'
              : item.variant === 'danger'
                ? 'mgg-ctx-danger'
                : '';
        const disabledCls = item.disabled ? 'mgg-ctx-disabled' : '';
        const iconHtml = item.icon ? `<span>${item.icon}</span>` : '';
        return `
          <button
            type="button"
            class="mgg-ctx-item ${variantCls} ${disabledCls}"
            data-ctx-idx="${idx}"
            style="display:flex;align-items:center;gap:8px;padding:6px 11px;cursor:pointer;color:${color};background:transparent;border:none;width:100%;text-align:left;font-family:inherit;font-size:11.5px;box-sizing:border-box;"
            ${item.disabled ? 'disabled' : ''}
          >
            ${iconHtml}
            <span>${MGG.escapeHtml(item.label)}</span>
          </button>
        `;
      })
      .join('');

    contextMenuEl.innerHTML = headerHtml + bodyHtml;

    // Montar al final de <html> con estilos críticos inline para evitar cualquier bloqueo de z-index/CSS
    document.documentElement.appendChild(contextMenuEl);
    Object.assign(contextMenuEl.style, {
      position: 'fixed',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      visibility: 'visible',
      opacity: '1',
      minWidth: '230px',
      maxWidth: '320px',
      background: '#030b05',
      border: '1.5px solid #00ff41',
      borderRadius: '6px',
      boxShadow: '0 8px 28px rgba(0,0,0,0.9), 0 0 18px rgba(0,255,65,0.35)',
      padding: '5px 0',
      left: '0px',
      top: '0px',
      fontFamily: "'Consolas', 'Fira Code', 'Courier New', monospace",
      fontSize: '11.5px',
      color: '#c8ffd6'
    });
    contextMenuEl.classList.add('mgg-open');

    const menuRect = contextMenuEl.getBoundingClientRect();
    const pad = 8;
    let left = clientX;
    let top = clientY;

    if (left + menuRect.width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - menuRect.width - pad);
    }
    if (top + menuRect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - menuRect.height - pad);
    }

    contextMenuEl.style.left = `${Math.round(left)}px`;
    contextMenuEl.style.top = `${Math.round(top)}px`;

    contextMenuEl.querySelectorAll('.mgg-ctx-item:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-ctx-idx'));
        const actionItem = validItems[idx];
        closeContextMenu();
        if (actionItem && typeof actionItem.onClick === 'function') {
          actionItem.onClick();
        }
      });
    });
  }

  // =====================================================================
  // MONTAJE DEL DOM DEL EXPLORADOR Y DIÁLOGOS
  // =====================================================================

  function mount(modalEl) {
    if (!modalEl) return;
    ensureContextMenu();

    if (!explorerEl) {
      explorerEl = document.createElement('div');
      explorerEl.id = 'mgg-explorer-overlay';
      explorerEl.className = 'mgg-explorer-overlay';
      explorerEl.innerHTML = `
        <div class="mgg-exp-header">
          <div class="mgg-exp-title">
            <button type="button" id="mgg-exp-back-btn" class="mgg-btn mgg-btn-sm" style="display:none;" title="Volver al commit anterior inspeccionado">← Volver</button>
            <span class="mgg-detail-sha" id="mgg-exp-sha"></span>
            <span class="mgg-exp-commit-meta" id="mgg-exp-meta"></span>
          </div>
          <div class="mgg-exp-toolbar">
            <span class="mgg-exp-stats" id="mgg-exp-stats"></span>
            <button type="button" id="mgg-exp-view-split" class="mgg-tab-btn">Split / Merge</button>
            <button type="button" id="mgg-exp-view-unified" class="mgg-tab-btn">Unificado</button>
            <button type="button" id="mgg-exp-tag-btn" class="mgg-btn mgg-btn-sm mgg-btn-tag" title="Crear Tag en este commit">🏷 Crear Tag</button>
            <button type="button" id="mgg-exp-revert-btn" class="mgg-btn mgg-btn-sm mgg-btn-cyan" style="display:none;" title="Revertir este Pull Request">↺ PR Revert</button>
            <a id="mgg-exp-gh-link" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">GitHub ↗</a>
            <button type="button" id="mgg-exp-close-btn" class="mgg-btn mgg-btn-sm mgg-btn-close">✕ Volver al Grafo</button>
          </div>
        </div>

        <div class="mgg-exp-body">
          <aside class="mgg-exp-sidebar" id="mgg-exp-sidebar">
            <div class="mgg-sidebar-resizer" id="mgg-exp-resizer" title="Arrastra para redimensionar panel de archivos"></div>
            <div class="mgg-sidebar-title">
              <span>ARCHIVOS MODIFICADOS</span>
              <span id="mgg-exp-file-count">0</span>
            </div>
            <input
              type="text"
              id="mgg-exp-file-filter"
              class="mgg-input"
              placeholder="Filtrar archivos..."
            />
            <div class="mgg-quick-actions">
              <button type="button" id="mgg-exp-prev-file" class="mgg-btn mgg-btn-sm">▲ Ant. archivo</button>
              <button type="button" id="mgg-exp-next-file" class="mgg-btn mgg-btn-sm">▼ Sig. archivo</button>
            </div>
            <div id="mgg-exp-file-list" class="mgg-exp-file-list"></div>
          </aside>

          <section class="mgg-exp-main">
            <div class="mgg-exp-subbar">
              <div class="mgg-exp-filepath" id="mgg-exp-filepath">Selecciona un archivo</div>
              <div class="mgg-exp-tabs">
                <button type="button" id="mgg-exp-tab-diff" class="mgg-tab-btn mgg-tab-active">Diff / Merge</button>
                <button type="button" id="mgg-exp-tab-history" class="mgg-tab-btn">Historial (Quién / Cuándo)</button>
              </div>
              <div class="mgg-exp-nav" id="mgg-exp-change-nav">
                <button type="button" id="mgg-exp-prev-change" class="mgg-btn mgg-btn-sm" title="Cambio anterior">▲ Cambio</button>
                <span id="mgg-exp-change-counter">0/0</span>
                <button type="button" id="mgg-exp-next-change" class="mgg-btn mgg-btn-sm" title="Siguiente cambio">▼ Cambio</button>
                <a id="mgg-exp-blob-link" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">Ver archivo ↗</a>
              </div>
            </div>
            <div id="mgg-exp-viewer" class="mgg-exp-viewer"></div>
          </section>
        </div>
      `;
      modalEl.appendChild(explorerEl);
      bindExplorerEvents();
    }

    if (!dialogBackdropEl) {
      dialogBackdropEl = document.createElement('div');
      dialogBackdropEl.id = 'mgg-dialog-backdrop';
      dialogBackdropEl.className = 'mgg-dialog-backdrop';
      dialogBackdropEl.innerHTML = '<div id="mgg-dialog-box" class="mgg-dialog-box"></div>';
      dialogBackdropEl.addEventListener('click', (e) => {
        if (e.target === dialogBackdropEl) closeDialog();
      });
      modalEl.appendChild(dialogBackdropEl);
    }
  }

  function bindExplorerEvents() {
    explorerEl.querySelector('#mgg-exp-close-btn').addEventListener('click', close);

    explorerEl.querySelector('#mgg-exp-back-btn').addEventListener('click', () => {
      if (navStack.length === 0) return;
      const prev = navStack.pop();
      openForCommit(prev.commit, prev.filePath, false);
    });

    explorerEl.querySelector('#mgg-exp-view-split').addEventListener('click', () => {
      state.diffViewMode = 'split';
      MGG.saveCurrentRepoConfig();
      syncDiffModeButtons();
      renderActiveFileViewer();
    });

    explorerEl.querySelector('#mgg-exp-view-unified').addEventListener('click', () => {
      state.diffViewMode = 'unified';
      MGG.saveCurrentRepoConfig();
      syncDiffModeButtons();
      renderActiveFileViewer();
    });

    explorerEl.querySelector('#mgg-exp-tab-diff').addEventListener('click', () => {
      state.explorer.activeTab = 'diff';
      syncTabButtons();
      renderActiveFileViewer();
    });

    explorerEl.querySelector('#mgg-exp-tab-history').addEventListener('click', () => {
      state.explorer.activeTab = 'history';
      syncTabButtons();
      renderActiveFileViewer();
    });

    explorerEl.querySelector('#mgg-exp-file-filter').addEventListener('input', (e) => {
      state.explorer.fileFilter = e.target.value.toLowerCase();
      renderFileList();
    });

    explorerEl.querySelector('#mgg-exp-prev-file').addEventListener('click', () => stepFile(-1));
    explorerEl.querySelector('#mgg-exp-next-file').addEventListener('click', () => stepFile(1));
    explorerEl.querySelector('#mgg-exp-prev-change').addEventListener('click', () => stepChange(-1));
    explorerEl.querySelector('#mgg-exp-next-change').addEventListener('click', () => stepChange(1));

    explorerEl.querySelector('#mgg-exp-tag-btn').addEventListener('click', () => {
      if (state.explorer.commit) openCreateTagDialog(state.explorer.commit);
    });

    explorerEl.querySelector('#mgg-exp-revert-btn').addEventListener('click', () => {
      if (!state.explorer.commit) return;
      const prNum = MGG.extractPrNumberFromMessage(state.explorer.commit.message);
      openPrRevertDialog(state.explorer.commit, prNum);
    });

    const sidebar = explorerEl.querySelector('#mgg-exp-sidebar');
    const handle = explorerEl.querySelector('#mgg-exp-resizer');
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebar.getBoundingClientRect().width;
      handle.classList.add('mgg-resizing');
      document.body.classList.add('mgg-no-select');

      const onMove = (ev) => {
        const nextW = Math.min(820, Math.max(180, Math.round(startW + (ev.clientX - startX))));
        state.explorerSidebarWidth = nextW;
        sidebar.style.width = `${nextW}px`;
      };

      const onUp = () => {
        handle.classList.remove('mgg-resizing');
        document.body.classList.remove('mgg-no-select');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        MGG.saveCurrentRepoConfig();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      state.explorerSidebarWidth = 300;
      sidebar.style.width = '300px';
      MGG.saveCurrentRepoConfig();
    });
  }

  function syncDiffModeButtons() {
    if (!explorerEl) return;
    explorerEl
      .querySelector('#mgg-exp-view-split')
      ?.classList.toggle('mgg-tab-active', state.diffViewMode === 'split');
    explorerEl
      .querySelector('#mgg-exp-view-unified')
      ?.classList.toggle('mgg-tab-active', state.diffViewMode === 'unified');
  }

  function syncTabButtons() {
    if (!explorerEl) return;
    const isDiff = state.explorer.activeTab === 'diff';
    explorerEl.querySelector('#mgg-exp-tab-diff')?.classList.toggle('mgg-tab-active', isDiff);
    explorerEl.querySelector('#mgg-exp-tab-history')?.classList.toggle('mgg-tab-active', !isDiff);
    const navEl = explorerEl.querySelector('#mgg-exp-change-nav');
    if (navEl) navEl.style.display = isDiff ? 'inline-flex' : 'none';
  }

  function isOpen() {
    return Boolean(explorerEl && explorerEl.classList.contains('mgg-open'));
  }

  function isDialogOpen() {
    return Boolean(dialogBackdropEl && dialogBackdropEl.classList.contains('mgg-open'));
  }

  function close() {
    closeContextMenu();
    if (!explorerEl) return;
    explorerEl.classList.remove('mgg-open');
    state.explorer.isOpen = false;
    navStack = [];
  }

  function closeDialog() {
    closeContextMenu();
    if (!dialogBackdropEl) return;
    dialogBackdropEl.classList.remove('mgg-open');
  }

  // =====================================================================
  // APERTURA Y CARGA DEL EXPLORADOR DE ARCHIVOS
  // =====================================================================

  async function openForCommit(commitOrSha, focusFilePath = '', pushCurrentToStack = false) {
    if (!state.repo || !explorerEl) return;
    const { owner, repo } = state.repo;

    if (pushCurrentToStack && state.explorer.isOpen && state.explorer.commit) {
      const currFile = state.explorer.files[state.explorer.selectedFileIdx]?.filename || '';
      navStack.push({ commit: state.explorer.commit, filePath: currFile });
    }

    let commitObj = typeof commitOrSha === 'string' ? state.commitMap.get(commitOrSha) : commitOrSha;
    if (!commitObj) {
      const sha = String(commitOrSha || '');
      commitObj = {
        sha,
        shortSha: sha.slice(0, 7),
        subject: sha.slice(0, 7),
        message: sha,
        author: 'Desconocido',
        date: '',
        htmlUrl: `https://github.com/${owner}/${repo}/commit/${sha}`
      };
    }

    state.explorer.isOpen = true;
    state.explorer.commitSha = commitObj.sha;
    state.explorer.commit = commitObj;
    state.explorer.files = [];
    state.explorer.selectedFileIdx = 0;
    state.explorer.activeTab = 'diff';
    state.explorer.fileFilter = '';
    state.explorer.changeAnchors = [];
    state.explorer.currentChangeIdx = -1;

    const sidebar = explorerEl.querySelector('#mgg-exp-sidebar');
    if (sidebar) sidebar.style.width = `${state.explorerSidebarWidth}px`;

    const backBtn = explorerEl.querySelector('#mgg-exp-back-btn');
    backBtn.style.display = navStack.length > 0 ? 'inline-flex' : 'none';

    explorerEl.querySelector('#mgg-exp-file-filter').value = '';
    explorerEl.querySelector('#mgg-exp-sha').textContent = commitObj.shortSha || commitObj.sha.slice(0, 7);

    const dateFormatted = MGG.formatDate(commitObj.date);
    const metaText = `${commitObj.subject || ''}  •  ${commitObj.author || ''}${
      dateFormatted ? ` (${dateFormatted})` : ''
    }`;
    const metaEl = explorerEl.querySelector('#mgg-exp-meta');
    metaEl.textContent = metaText;
    metaEl.title = metaText;

    const ghLink = explorerEl.querySelector('#mgg-exp-gh-link');
    ghLink.href = commitObj.htmlUrl || `https://github.com/${owner}/${repo}/commit/${commitObj.sha}`;

    const prNum = MGG.extractPrNumberFromMessage(commitObj.message);
    const revertBtn = explorerEl.querySelector('#mgg-exp-revert-btn');
    if (prNum) {
      revertBtn.style.display = 'inline-flex';
      revertBtn.textContent = `↺ Revert PR #${prNum}`;
    } else {
      revertBtn.style.display = 'none';
    }

    explorerEl.querySelector('#mgg-exp-stats').innerHTML =
      '<span class="mgg-stat-files">Cargando...</span>';
    explorerEl.querySelector('#mgg-exp-file-count').textContent = '0';
    explorerEl.querySelector('#mgg-exp-file-list').innerHTML =
      '<div class="mgg-empty-state" style="padding:18px;">Leyendo archivos modificados...</div>';
    explorerEl.querySelector('#mgg-exp-viewer').innerHTML =
      '<div class="mgg-empty-state">Cargando diff de archivos desde GitHub...</div>';

    syncDiffModeButtons();
    syncTabButtons();
    explorerEl.classList.add('mgg-open');

    const res = await MGG.github.fetchCommitDiff(owner, repo, commitObj.sha);
    if (!state.explorer.isOpen || state.explorer.commitSha !== commitObj.sha) return;

    if (!res || !res.ok) {
      explorerEl.querySelector('#mgg-exp-stats').innerHTML = '<span class="mgg-stat-del">Error</span>';
      explorerEl.querySelector('#mgg-exp-viewer').innerHTML = `<div class="mgg-error-box">${MGG.escapeHtml(
        res?.error || 'No se pudieron cargar los cambios de este commit.'
      )}</div>`;
      return;
    }

    state.explorer.files = Array.isArray(res.files) ? res.files : [];
    const stats = res.stats || { additions: 0, deletions: 0, total: state.explorer.files.length };

    explorerEl.querySelector('#mgg-exp-stats').innerHTML = `
      <span class="mgg-stat-files">${stats.total} archivo(s)</span>
      <span class="mgg-stat-add">+${stats.additions}</span>
      <span class="mgg-stat-del">-${stats.deletions}</span>
    `;

    if (focusFilePath) {
      const idx = state.explorer.files.findIndex((f) => f.filename === focusFilePath);
      state.explorer.selectedFileIdx = idx !== -1 ? idx : 0;
    } else {
      state.explorer.selectedFileIdx = 0;
    }

    renderFileList();
    renderActiveFileViewer();
  }

  function getFilteredFileEntries() {
    const q = state.explorer.fileFilter;
    return state.explorer.files
      .map((file, idx) => ({ file, idx }))
      .filter(({ file }) => !q || file.filename.toLowerCase().includes(q));
  }

  function renderFileList() {
    const listEl = explorerEl.querySelector('#mgg-exp-file-list');
    const countEl = explorerEl.querySelector('#mgg-exp-file-count');
    const entries = getFilteredFileEntries();

    countEl.textContent = `${entries.length}/${state.explorer.files.length}`;

    if (entries.length === 0) {
      listEl.innerHTML = '<div class="mgg-empty-state" style="padding:16px;">Sin archivos coincidentes</div>';
      return;
    }

    listEl.innerHTML = entries
      .map(({ file, idx }) => {
        const isActive = idx === state.explorer.selectedFileIdx;
        const lastSlash = file.filename.lastIndexOf('/');
        const baseName = lastSlash !== -1 ? file.filename.slice(lastSlash + 1) : file.filename;
        const dirName = lastSlash !== -1 ? file.filename.slice(0, lastSlash) : '';
        const status = file.status || 'M';

        return `
          <div class="mgg-exp-file-item ${
            isActive ? 'mgg-file-active' : ''
          }" data-mgg-ctx="1" data-file-idx="${idx}" title="${MGG.escapeHtml(file.filename)}">
            <span class="mgg-file-status mgg-st-${MGG.escapeHtml(status)}">${MGG.escapeHtml(
          status
        )}</span>
            <div class="mgg-file-name-wrap">
              <span class="mgg-file-base">${MGG.escapeHtml(baseName)}</span>
              ${dirName ? `<span class="mgg-file-dir">${MGG.escapeHtml(dirName)}</span>` : ''}
            </div>
            <div class="mgg-file-nums">
              ${file.additions ? `<span class="mgg-stat-add">+${file.additions}</span>` : ''}
              ${file.deletions ? `<span class="mgg-stat-del">-${file.deletions}</span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.mgg-exp-file-item').forEach((row) => {
      const idx = Number(row.getAttribute('data-file-idx'));
      row.addEventListener('click', () => {
        if (Number.isNaN(idx)) return;
        state.explorer.selectedFileIdx = idx;
        renderFileList();
        renderActiveFileViewer();
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = state.explorer.files[idx];
        if (!file) return;
        state.explorer.selectedFileIdx = idx;
        renderFileList();
        renderActiveFileViewer();

        openContextMenu(e.clientX, e.clientY, `Archivo: ${file.filename}`, [
          {
            icon: '📄',
            label: 'Ver Diff / Merge',
            onClick: () => {
              state.explorer.activeTab = 'diff';
              syncTabButtons();
              renderActiveFileViewer();
            }
          },
          {
            icon: '🕒',
            label: 'Ver Historial (Quién / Cuándo)',
            variant: 'cyan',
            onClick: () => {
              state.explorer.activeTab = 'history';
              syncTabButtons();
              renderActiveFileViewer();
            }
          },
          { separator: true },
          {
            icon: '📋',
            label: 'Copiar ruta del archivo',
            onClick: () => {
              navigator.clipboard?.writeText(file.filename);
              callbacks.setStatus(`Ruta copiada: ${file.filename}`);
            }
          },
          {
            icon: '↗',
            label: 'Abrir archivo en GitHub',
            onClick: () => {
              if (file.blobUrl) window.open(file.blobUrl, '_blank', 'noopener,noreferrer');
            }
          }
        ]);
      });
    });
  }

  function stepFile(delta) {
    const entries = getFilteredFileEntries();
    if (entries.length === 0) return;
    const pos = entries.findIndex((e) => e.idx === state.explorer.selectedFileIdx);
    const nextPos = pos === -1 ? 0 : (pos + delta + entries.length) % entries.length;
    state.explorer.selectedFileIdx = entries[nextPos].idx;
    renderFileList();
    renderActiveFileViewer();

    const activeRow = explorerEl.querySelector(
      `.mgg-exp-file-item[data-file-idx="${state.explorer.selectedFileIdx}"]`
    );
    activeRow?.scrollIntoView({ block: 'nearest' });
  }

  // =====================================================================
  // RENDERIZADO DEL VISOR: DIFF SPLIT/MERGE, UNIFICADO E HISTORIAL
  // =====================================================================

  function renderActiveFileViewer() {
    const viewer = explorerEl.querySelector('#mgg-exp-viewer');
    const pathEl = explorerEl.querySelector('#mgg-exp-filepath');
    const blobLink = explorerEl.querySelector('#mgg-exp-blob-link');
    const counterEl = explorerEl.querySelector('#mgg-exp-change-counter');

    const file = state.explorer.files[state.explorer.selectedFileIdx];
    if (!file) {
      pathEl.textContent = 'Sin archivos en este commit';
      counterEl.textContent = '0/0';
      blobLink.style.display = 'none';
      viewer.innerHTML =
        '<div class="mgg-empty-state">Este commit no contiene cambios de archivo visibles (puede ser un commit vacío o un merge sin cambios propios en el primer diff).</div>';
      return;
    }

    const label = file.previousFilename
      ? `${file.previousFilename} → ${file.filename}`
      : file.filename;
    pathEl.textContent = label;
    pathEl.title = label;

    blobLink.style.display = 'inline-flex';
    blobLink.href = file.blobUrl || '#';

    if (state.explorer.activeTab === 'history') {
      renderFileHistoryTab(file);
      return;
    }

    if (!file.patch) {
      counterEl.textContent = '0/0';
      state.explorer.changeAnchors = [];
      state.explorer.currentChangeIdx = -1;
      viewer.innerHTML = `
        <div class="mgg-empty-state">
          <p>GitHub no devolvió diff de texto para <strong>${MGG.escapeHtml(
            file.filename
          )}</strong> (archivo binario, renombrado sin cambios o diff demasiado extenso).</p>
          <p style="margin-top:10px;">
            <a href="${MGG.escapeHtml(
              file.blobUrl || '#'
            )}" target="_blank" rel="noopener noreferrer" class="mgg-btn">Abrir archivo en GitHub ↗</a>
          </p>
        </div>
      `;
      return;
    }

    viewer.innerHTML = renderDiffHtml(file.patch, state.diffViewMode);

    const anchors = Array.from(viewer.querySelectorAll('.mgg-change-anchor'));
    state.explorer.changeAnchors = anchors;
    state.explorer.currentChangeIdx = anchors.length > 0 ? 0 : -1;
    updateChangeCounterUI();
    viewer.scrollTop = 0;
  }

  function updateChangeCounterUI() {
    const counterEl = explorerEl.querySelector('#mgg-exp-change-counter');
    const total = state.explorer.changeAnchors.length;
    const curr = state.explorer.currentChangeIdx;
    counterEl.textContent = total > 0 ? `${curr + 1}/${total}` : '0/0';
  }

  function stepChange(delta) {
    const anchors = state.explorer.changeAnchors;
    if (!anchors || anchors.length === 0) return;

    anchors.forEach((el) => el.classList.remove('mgg-change-active'));
    const nextIdx =
      state.explorer.currentChangeIdx === -1
        ? 0
        : (state.explorer.currentChangeIdx + delta + anchors.length) % anchors.length;

    state.explorer.currentChangeIdx = nextIdx;
    const target = anchors[nextIdx];
    target.classList.add('mgg-change-active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateChangeCounterUI();
  }

  async function renderFileHistoryTab(file) {
    const viewer = explorerEl.querySelector('#mgg-exp-viewer');
    const { owner, repo } = state.repo;
    const sha = state.explorer.commitSha;

    viewer.innerHTML = `<div class="mgg-empty-state">Cargando historial de ediciones de <strong>${MGG.escapeHtml(
      file.filename
    )}</strong>...</div>`;

    const res = await MGG.github.fetchFileHistory(owner, repo, sha, file.filename);
    if (!state.explorer.isOpen || state.explorer.activeTab !== 'history') return;

    if (!res || !res.ok) {
      viewer.innerHTML = `<div class="mgg-error-box">${MGG.escapeHtml(
        res?.error || 'No se pudo cargar el historial de este archivo.'
      )}</div>`;
      return;
    }

    const commits = Array.isArray(res.commits) ? res.commits : [];
    if (commits.length === 0) {
      viewer.innerHTML =
        '<div class="mgg-empty-state">Sin commits históricos encontrados para este archivo.</div>';
      return;
    }

    viewer.innerHTML = `
      <div class="mgg-history-list">
        ${commits
          .map((c) => {
            const isCurrent = c.sha === state.explorer.commitSha;
            const inGraph = state.commitMap.has(c.sha);
            return `
              <div class="mgg-history-card ${isCurrent ? 'mgg-history-current' : ''}">
                <div class="mgg-history-info">
                  <div class="mgg-history-msg" title="${MGG.escapeHtml(c.message)}">${MGG.escapeHtml(
              c.subject
            )}</div>
                  <div class="mgg-history-meta">
                    <span class="mgg-detail-sha">${MGG.escapeHtml(c.shortSha)}</span>
                    <span>Editó: <strong>${MGG.escapeHtml(c.author)}</strong></span>
                    <span>Cuándo: <strong>${MGG.escapeHtml(
                      MGG.formatDate(c.date) || 'Sin fecha'
                    )}</strong></span>
                    ${isCurrent ? '<span class="mgg-merge-tag">ACTUAL</span>' : ''}
                  </div>
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                  ${
                    isCurrent
                      ? '<button type="button" class="mgg-btn mgg-btn-sm mgg-hist-back-diff">Ver Diff</button>'
                      : `<button type="button" class="mgg-btn mgg-btn-sm mgg-hist-open-diff" data-sha="${MGG.escapeHtml(
                          c.sha
                        )}">Inspeccionar Diff</button>`
                  }
                  ${
                    inGraph
                      ? `<button type="button" class="mgg-btn mgg-btn-sm mgg-btn-cyan mgg-hist-goto-graph" data-sha="${MGG.escapeHtml(
                          c.sha
                        )}">Ver en Grafo</button>`
                      : ''
                  }
                  <a href="${MGG.escapeHtml(
                    c.htmlUrl
                  )}" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">GitHub ↗</a>
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;

    viewer.querySelectorAll('.mgg-hist-back-diff').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.explorer.activeTab = 'diff';
        syncTabButtons();
        renderActiveFileViewer();
      });
    });

    viewer.querySelectorAll('.mgg-hist-open-diff').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetSha = btn.getAttribute('data-sha');
        const targetCommit = commits.find((x) => x.sha === targetSha) || targetSha;
        openForCommit(targetCommit, file.filename, true);
      });
    });

    viewer.querySelectorAll('.mgg-hist-goto-graph').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetSha = btn.getAttribute('data-sha');
        close();
        callbacks.selectAndScrollToSha(targetSha);
      });
    });
  }

  // =====================================================================
  // DIÁLOGO: CREAR PULL REQUEST (SESIÓN SAML / API PAT / COMPARACIÓN WEB)
  // =====================================================================

  function openCreatePrDialog(options = {}) {
    if (!dialogBackdropEl || !state.repo) return;
    const { owner, repo } = state.repo;
    const box = dialogBackdropEl.querySelector('#mgg-dialog-box');

    const allBranches = [...state.branches].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    );

    if (allBranches.length < 2) {
      box.innerHTML = `
        <div class="mgg-dialog-title">
          <span>🔀 CREAR PULL REQUEST</span>
          <button type="button" id="mgg-dlg-close" class="mgg-btn mgg-btn-sm mgg-btn-close">✕</button>
        </div>
        <div style="font-size:12px; color:#ffb3c1;">
          Se necesitan al menos 2 ramas cargadas en el repositorio para crear un Pull Request.
        </div>
        <div class="mgg-dialog-actions">
          <button type="button" id="mgg-dlg-ok" class="mgg-btn mgg-btn-sm">Cerrar</button>
        </div>
      `;
      box.querySelector('#mgg-dlg-close').addEventListener('click', closeDialog);
      box.querySelector('#mgg-dlg-ok').addEventListener('click', closeDialog);
      dialogBackdropEl.classList.add('mgg-open');
      return;
    }

    const branchNames = allBranches.map((b) => b.name);
    const orderedSelected = MGG.getOrderedSelectedBranches();
    const basePriority = ['develop', 'dev', 'main', 'master'];

    let defaultHead = options.head && branchNames.includes(options.head) ? options.head : '';
    let defaultBase = options.base && branchNames.includes(options.base) ? options.base : '';

    if (!defaultBase) {
      defaultBase =
        orderedSelected.find((n) => n !== defaultHead) ||
        branchNames.find((n) => basePriority.includes(n.toLowerCase()) && n !== defaultHead) ||
        branchNames.find((n) => n !== defaultHead) ||
        branchNames[0];
    }

    if (!defaultHead || defaultHead === defaultBase) {
      defaultHead =
        orderedSelected.find((n) => n !== defaultBase) ||
        branchNames.find((n) => n !== defaultBase) ||
        branchNames[0];
    }

    const hasApiToken = state.tokens.length > 0;
    const branchOptionsHtml = (selectedVal) =>
      branchNames
        .map(
          (name) =>
            `<option value="${MGG.escapeHtml(name)}" ${
              name === selectedVal ? 'selected' : ''
            }>${MGG.escapeHtml(name)}</option>`
        )
        .join('');

    box.innerHTML = `
      <div class="mgg-dialog-title">
        <span>🔀 CREAR PULL REQUEST (${MGG.escapeHtml(owner)}/${MGG.escapeHtml(repo)})</span>
        <button type="button" id="mgg-dlg-close" class="mgg-btn mgg-btn-sm mgg-btn-close">✕</button>
      </div>

      <div style="display:flex; align-items:flex-end; gap:8px;">
        <div class="mgg-dialog-field" style="flex:1; min-width:0;">
          <label for="mgg-pr-head-sel">Rama origen (compare / head):</label>
          <select id="mgg-pr-head-sel" class="mgg-select" style="width:100%;">
            ${branchOptionsHtml(defaultHead)}
          </select>
        </div>
        <button type="button" id="mgg-pr-swap-btn" class="mgg-btn mgg-btn-sm" style="height:28px;" title="Invertir rama origen y destino">⇄</button>
        <div class="mgg-dialog-field" style="flex:1; min-width:0;">
          <label for="mgg-pr-base-sel">Rama destino (base):</label>
          <select id="mgg-pr-base-sel" class="mgg-select" style="width:100%;">
            ${branchOptionsHtml(defaultBase)}
          </select>
        </div>
      </div>

      <div style="font-size:11px; color:#00f0ff;" id="mgg-pr-flow-preview"></div>

      <div class="mgg-dialog-field">
        <label for="mgg-pr-title-input">Título del Pull Request:</label>
        <input type="text" id="mgg-pr-title-input" class="mgg-input" placeholder="Título del PR..." />
      </div>

      <div class="mgg-dialog-field">
        <label for="mgg-pr-body-input">Descripción (opcional):</label>
        <textarea id="mgg-pr-body-input" class="mgg-textarea" rows="4" placeholder="Resumen de cambios, validaciones o ticket..."></textarea>
      </div>

      <label class="mgg-toggle-label">
        <input type="checkbox" id="mgg-pr-draft-chk" />
        <span>Crear como Draft Pull Request (borrador)</span>
      </label>

      <div id="mgg-dlg-feedback" style="font-size:11.5px; color:#00f0ff; min-height:18px; line-height:1.45;"></div>

      <div class="mgg-dialog-actions">
        <a id="mgg-pr-compare-link" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">Abrir comparación ↗</a>
        ${
          hasApiToken
            ? '<button type="button" id="mgg-pr-submit-api" class="mgg-btn mgg-btn-sm mgg-btn-cyan">Crear vía API (PAT)</button>'
            : ''
        }
        <button type="button" id="mgg-pr-submit-web" class="mgg-btn mgg-btn-sm">Crear PR (Sesión SAML)</button>
      </div>
    `;

    const headSel = box.querySelector('#mgg-pr-head-sel');
    const baseSel = box.querySelector('#mgg-pr-base-sel');
    const swapBtn = box.querySelector('#mgg-pr-swap-btn');
    const titleInput = box.querySelector('#mgg-pr-title-input');
    const bodyInput = box.querySelector('#mgg-pr-body-input');
    const draftChk = box.querySelector('#mgg-pr-draft-chk');
    const flowPreview = box.querySelector('#mgg-pr-flow-preview');
    const compareLink = box.querySelector('#mgg-pr-compare-link');
    const feedbackEl = box.querySelector('#mgg-dlg-feedback');

    let userEditedTitle = Boolean(options.title);
    if (options.title) titleInput.value = options.title;
    if (options.body) bodyInput.value = options.body;

    const refreshPreview = () => {
      const h = headSel.value;
      const b = baseSel.value;
      if (!userEditedTitle) {
        titleInput.value = `Merge ${h} into ${b}`;
      }
      flowPreview.textContent =
        h === b
          ? '⚠ La rama origen y la rama destino son iguales.'
          : `Flujo: ${h}  ➜  ${b}`;
      flowPreview.style.color = h === b ? '#ff4d6d' : '#00f0ff';
      compareLink.href = MGG.github.buildCompareUrl(
        owner,
        repo,
        h,
        b,
        titleInput.value,
        bodyInput.value
      );
    };

    titleInput.addEventListener('input', () => {
      userEditedTitle = titleInput.value.trim().length > 0;
      refreshPreview();
    });
    bodyInput.addEventListener('input', refreshPreview);
    headSel.addEventListener('change', refreshPreview);
    baseSel.addEventListener('change', refreshPreview);

    swapBtn.addEventListener('click', () => {
      const prevHead = headSel.value;
      headSel.value = baseSel.value;
      baseSel.value = prevHead;
      refreshPreview();
    });

    box.querySelector('#mgg-dlg-close').addEventListener('click', closeDialog);
    refreshPreview();

    const validateFields = () => {
      const head = headSel.value;
      const base = baseSel.value;
      const title = titleInput.value.trim();
      if (!head || !base) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'Selecciona rama origen y rama destino.';
        return null;
      }
      if (head === base) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'La rama origen y la rama destino deben ser diferentes.';
        return null;
      }
      if (!title) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'Escribe un título para el Pull Request.';
        return null;
      }
      return { head, base, title, body: bodyInput.value, draft: draftChk.checked };
    };

    const showPrResult = (res, isApi) => {
      if (res.ok) {
        const prLabel = res.number ? `PR #${res.number}` : 'Pull Request';
        feedbackEl.style.color = '#00ff41';
        feedbackEl.innerHTML = `${MGG.escapeHtml(
          prLabel
        )} creado correctamente. <a href="${MGG.escapeHtml(
          res.url
        )}" target="_blank" rel="noopener noreferrer" style="color:#00f0ff; text-decoration:underline;">Abrir ${MGG.escapeHtml(
          prLabel
        )} en GitHub ↗</a>`;
        window.open(res.url, '_blank', 'noopener,noreferrer');
        callbacks.setStatus(`${prLabel} creado (${headSel.value} → ${baseSel.value}).`);
        return;
      }

      feedbackEl.style.color = '#ff4d6d';
      if (isApi && res.isSaml) {
        feedbackEl.textContent =
          'El PAT está bloqueado por SAML SSO. Usa "Crear PR (Sesión SAML)" o "Abrir comparación ↗".';
      } else if (res.existingUrl) {
        feedbackEl.innerHTML = `${MGG.escapeHtml(
          res.error
        )} <a href="${MGG.escapeHtml(
          res.existingUrl
        )}" target="_blank" rel="noopener noreferrer" style="color:#00f0ff; text-decoration:underline;">Ver PR existente ↗</a>`;
      } else {
        feedbackEl.textContent = res.error || 'No se pudo crear el Pull Request.';
      }
    };

    const apiBtn = box.querySelector('#mgg-pr-submit-api');
    if (apiBtn) {
      apiBtn.addEventListener('click', async () => {
        const data = validateFields();
        if (!data) return;
        apiBtn.disabled = true;
        feedbackEl.style.color = '#00f0ff';
        feedbackEl.textContent = `Creando Pull Request (${data.head} → ${data.base}) vía API...`;

        const res = await MGG.github.apiCreatePullRequest(
          owner,
          repo,
          data.head,
          data.base,
          data.title,
          data.body,
          data.draft
        );
        apiBtn.disabled = false;
        showPrResult(res, true);
      });
    }

    const webBtn = box.querySelector('#mgg-pr-submit-web');
    webBtn.addEventListener('click', async () => {
      const data = validateFields();
      if (!data) return;
      webBtn.disabled = true;
      feedbackEl.style.color = '#ffca28';
      feedbackEl.textContent = `Creando Pull Request (${data.head} → ${data.base}) vía Sesión SAML...`;

      const res = await MGG.github.webCreatePullRequest(
        owner,
        repo,
        data.head,
        data.base,
        data.title,
        data.body,
        data.draft
      );
      webBtn.disabled = false;
      showPrResult(res, false);
    });

    dialogBackdropEl.classList.add('mgg-open');
    titleInput.focus();
    titleInput.select();
  }

  // =====================================================================
  // DIÁLOGO: CREAR TAG Y ELIMINAR TAG
  // =====================================================================

  function openCreateTagDialog(commit) {
    if (!dialogBackdropEl || !state.repo || !commit) return;
    const { owner, repo } = state.repo;
    const box = dialogBackdropEl.querySelector('#mgg-dialog-box');

    const hasApiToken = state.tokens.length > 0;
    const shortSha = commit.shortSha || commit.sha.slice(0, 7);

    box.innerHTML = `
      <div class="mgg-dialog-title">
        <span>🏷 CREAR TAG EN COMMIT ${MGG.escapeHtml(shortSha)}</span>
        <button type="button" id="mgg-dlg-close" class="mgg-btn mgg-btn-sm mgg-btn-close">✕</button>
      </div>
      <div style="font-size:11px; color:#79d48f;">
        Commit: <strong>${MGG.escapeHtml(commit.subject || shortSha)}</strong>
      </div>
      <div class="mgg-dialog-field">
        <label for="mgg-tag-name-input">Nombre del Tag (sin espacios, ej. v1.4.0 o Aplicacion_Reverso_02):</label>
        <input type="text" id="mgg-tag-name-input" class="mgg-input" placeholder="Nombre del tag..." />
      </div>
      <div class="mgg-dialog-field">
        <label for="mgg-tag-msg-input">Mensaje / Notas (opcional):</label>
        <textarea id="mgg-tag-msg-input" class="mgg-textarea" rows="2" placeholder="Descripción del tag..."></textarea>
      </div>
      <div class="mgg-dialog-field">
        <span>Comando Git equivalente (por si prefieres crearlo local sin Release):</span>
        <div class="mgg-dialog-cmd" id="mgg-tag-cmd-preview"></div>
      </div>
      <div id="mgg-dlg-feedback" style="font-size:11.5px; color:#ffca28; min-height:16px;"></div>
      <div class="mgg-dialog-actions">
        <button type="button" id="mgg-tag-copy-cmd" class="mgg-btn mgg-btn-sm">Copiar comando Git</button>
        <a id="mgg-tag-open-gh" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">Abrir en GitHub ↗</a>
        ${
          hasApiToken
            ? '<button type="button" id="mgg-tag-submit-api" class="mgg-btn mgg-btn-sm mgg-btn-cyan">Crear vía API (PAT)</button>'
            : ''
        }
        <button type="button" id="mgg-tag-submit-web" class="mgg-btn mgg-btn-sm mgg-btn-tag">Crear Tag (Sesión SAML)</button>
      </div>
    `;

    const nameInput = box.querySelector('#mgg-tag-name-input');
    const msgInput = box.querySelector('#mgg-tag-msg-input');
    const cmdEl = box.querySelector('#mgg-tag-cmd-preview');
    const openGhEl = box.querySelector('#mgg-tag-open-gh');
    const feedbackEl = box.querySelector('#mgg-dlg-feedback');

    const updatePreview = () => {
      const tName = nameInput.value.trim() || 'MI_TAG';
      const tMsg = msgInput.value.trim();
      const cmd = tMsg
        ? `git tag -a ${tName} ${commit.sha} -m "${tMsg.replace(/"/g, '\\"')}" && git push origin ${tName}`
        : `git tag ${tName} ${commit.sha} && git push origin ${tName}`;
      cmdEl.textContent = cmd;
      openGhEl.href = `https://github.com/${owner}/${repo}/releases/new?tag=${encodeURIComponent(
        nameInput.value.trim()
      )}&target=${encodeURIComponent(commit.sha)}`;
    };

    nameInput.addEventListener('input', updatePreview);
    msgInput.addEventListener('input', updatePreview);
    updatePreview();

    box.querySelector('#mgg-dlg-close').addEventListener('click', closeDialog);

    box.querySelector('#mgg-tag-copy-cmd').addEventListener('click', (e) => {
      navigator.clipboard?.writeText(cmdEl.textContent);
      e.target.textContent = '¡Copiado!';
      setTimeout(() => {
        e.target.textContent = 'Copiar comando Git';
      }, 1200);
    });

    const validateTagName = () => {
      const raw = nameInput.value.trim();
      if (!raw) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'Escribe un nombre válido para el tag.';
        return null;
      }
      if (/\s/.test(raw)) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'El nombre del tag no puede contener espacios.';
        return null;
      }
      return raw;
    };

    const onTagCreated = async (tagName) => {
      feedbackEl.style.color = '#00ff41';
      feedbackEl.textContent = `Tag "${tagName}" creado correctamente. Actualizando grafo...`;
      await MGG.github.fetchRepoTags(owner, repo);
      if (!state.tags.some((t) => t.name === tagName)) {
        state.tags.unshift({ name: tagName, sha: commit.sha, timestamp: Date.now() });
        MGG.rebuildTagsBySha();
      }
      callbacks.renderBranchSidebar();
      callbacks.renderGraph();
      if (state.activeSha && state.commitMap.has(state.activeSha)) {
        callbacks.showCommitDetails(state.commitMap.get(state.activeSha));
      }
      callbacks.setStatus(`Tag "${tagName}" creado en ${shortSha}.`);
      setTimeout(() => closeDialog(), 900);
    };

    const apiBtn = box.querySelector('#mgg-tag-submit-api');
    if (apiBtn) {
      apiBtn.addEventListener('click', async () => {
        const tagName = validateTagName();
        if (!tagName) return;
        apiBtn.disabled = true;
        feedbackEl.style.color = '#00f0ff';
        feedbackEl.textContent = 'Creando tag vía API de GitHub...';

        const res = await MGG.github.apiCreateTag(owner, repo, commit.sha, tagName, msgInput.value);
        apiBtn.disabled = false;
        if (res.ok) {
          await onTagCreated(tagName);
        } else {
          feedbackEl.style.color = '#ff4d6d';
          feedbackEl.textContent = res.isSaml
            ? 'El PAT está bloqueado por SAML SSO. Usa "Crear Tag (Sesión SAML)".'
            : res.error || 'No se pudo crear el tag vía API.';
        }
      });
    }

    const webBtn = box.querySelector('#mgg-tag-submit-web');
    webBtn.addEventListener('click', async () => {
      const tagName = validateTagName();
      if (!tagName) return;
      webBtn.disabled = true;
      feedbackEl.style.color = '#ffca28';
      feedbackEl.textContent = 'Creando tag vía Sesión Web (SAML)...';

      const res = await MGG.github.webCreateTagViaRelease(
        owner,
        repo,
        commit.sha,
        tagName,
        tagName,
        msgInput.value.trim()
      );
      webBtn.disabled = false;
      if (res.ok) {
        await onTagCreated(tagName);
      } else {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = res.error || 'No se pudo crear el tag con la sesión web.';
      }
    });

    dialogBackdropEl.classList.add('mgg-open');
    nameInput.focus();
  }

  function openDeleteTagDialog(tagName, tagSha = '') {
    if (!dialogBackdropEl || !state.repo || !tagName) return;
    const { owner, repo } = state.repo;
    const box = dialogBackdropEl.querySelector('#mgg-dialog-box');
    const hasApiToken = state.tokens.length > 0;
    const deleteGitCmd = `git push origin :refs/tags/${tagName}`;

    box.innerHTML = `
      <div class="mgg-dialog-title">
        <span style="color:#ff6b86;">🗑 ELIMINAR TAG "${MGG.escapeHtml(tagName)}"</span>
        <button type="button" id="mgg-dlg-close" class="mgg-btn mgg-btn-sm mgg-btn-close">✕</button>
      </div>
      <div style="font-size:11.5px; color:#ffc7d2; line-height:1.45;">
        ¿Seguro que deseas eliminar el tag <strong>${MGG.escapeHtml(tagName)}</strong>${
      tagSha ? ` (<code>${MGG.escapeHtml(tagSha.slice(0, 7))}</code>)` : ''
    } en <strong>${MGG.escapeHtml(owner)}/${MGG.escapeHtml(repo)}</strong>? Esta acción borra la referencia remota en GitHub.
      </div>
      <div class="mgg-dialog-field">
        <span>Comando Git equivalente:</span>
        <div class="mgg-dialog-cmd">${MGG.escapeHtml(deleteGitCmd)}</div>
      </div>
      <div id="mgg-dlg-feedback" style="font-size:11.5px; color:#ffca28; min-height:16px;"></div>
      <div class="mgg-dialog-actions">
        <button type="button" id="mgg-del-tag-copy" class="mgg-btn mgg-btn-sm">Copiar comando</button>
        <a href="https://github.com/${owner}/${repo}/tags" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">Ver Tags en GitHub ↗</a>
        ${
          hasApiToken
            ? '<button type="button" id="mgg-del-tag-api" class="mgg-btn mgg-btn-sm mgg-btn-close">Eliminar vía API (PAT)</button>'
            : ''
        }
        <button type="button" id="mgg-del-tag-web" class="mgg-btn mgg-btn-sm mgg-btn-close">Eliminar (Sesión SAML)</button>
      </div>
    `;

    const feedbackEl = box.querySelector('#mgg-dlg-feedback');
    box.querySelector('#mgg-dlg-close').addEventListener('click', closeDialog);

    box.querySelector('#mgg-del-tag-copy').addEventListener('click', (e) => {
      navigator.clipboard?.writeText(deleteGitCmd);
      e.target.textContent = '¡Copiado!';
      setTimeout(() => {
        e.target.textContent = 'Copiar comando';
      }, 1200);
    });

    const onTagDeleted = async () => {
      state.tags = state.tags.filter((t) => t.name !== tagName);
      MGG.rebuildTagsBySha();
      feedbackEl.style.color = '#00ff41';
      feedbackEl.textContent = `Tag "${tagName}" eliminado correctamente.`;
      callbacks.renderBranchSidebar();
      callbacks.renderGraph();
      if (state.activeSha && state.commitMap.has(state.activeSha)) {
        callbacks.showCommitDetails(state.commitMap.get(state.activeSha));
      }
      callbacks.setStatus(`Tag "${tagName}" eliminado.`);
      setTimeout(() => closeDialog(), 800);
    };

    const apiBtn = box.querySelector('#mgg-del-tag-api');
    if (apiBtn) {
      apiBtn.addEventListener('click', async () => {
        apiBtn.disabled = true;
        feedbackEl.style.color = '#00f0ff';
        feedbackEl.textContent = `Eliminando tag "${tagName}" vía API...`;
        const res = await MGG.github.apiDeleteTag(owner, repo, tagName);
        apiBtn.disabled = false;
        if (res.ok) {
          await onTagDeleted();
        } else {
          feedbackEl.style.color = '#ff4d6d';
          feedbackEl.textContent = res.isSaml
            ? 'PAT bloqueado por SAML SSO. Usa "Eliminar (Sesión SAML)".'
            : res.error || 'No se pudo eliminar el tag vía API.';
        }
      });
    }

    const webBtn = box.querySelector('#mgg-del-tag-web');
    webBtn.addEventListener('click', async () => {
      webBtn.disabled = true;
      feedbackEl.style.color = '#ffca28';
      feedbackEl.textContent = `Eliminando tag "${tagName}" vía Sesión Web (SAML)...`;
      const res = await MGG.github.webDeleteTag(owner, repo, tagName);
      webBtn.disabled = false;
      if (res.ok) {
        await onTagDeleted();
      } else {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = res.error || 'No se pudo eliminar el tag con la sesión web.';
      }
    });

    dialogBackdropEl.classList.add('mgg-open');
  }

  // =====================================================================
  // DIÁLOGO: PULL REQUEST REVERT (SESIÓN WEB SAML + COMANDO GIT)
  // =====================================================================

  function openPrRevertDialog(commit, detectedPrNumber) {
    if (!dialogBackdropEl || !state.repo || !commit) return;
    const { owner, repo } = state.repo;
    const box = dialogBackdropEl.querySelector('#mgg-dialog-box');
    const shortSha = commit.shortSha || commit.sha.slice(0, 7);
    const isMerge = Array.isArray(commit.parents) && commit.parents.length > 1;
    const gitRevertCmd = isMerge ? `git revert -m 1 ${commit.sha}` : `git revert ${commit.sha}`;

    box.innerHTML = `
      <div class="mgg-dialog-title">
        <span>↺ PULL REQUEST REVERT</span>
        <button type="button" id="mgg-dlg-close" class="mgg-btn mgg-btn-sm mgg-btn-close">✕</button>
      </div>
      <div style="font-size:11.5px; color:#b7ffca;">
        Commit: <strong class="mgg-detail-sha">${MGG.escapeHtml(shortSha)}</strong> — ${MGG.escapeHtml(
      commit.subject || ''
    )}
      </div>
      <div class="mgg-dialog-field">
        <label for="mgg-pr-num-input">Número de Pull Request a revertir:</label>
        <input type="number" id="mgg-pr-num-input" class="mgg-input" min="1" value="${
          detectedPrNumber ? String(detectedPrNumber) : ''
        }" placeholder="Ej. 92" />
      </div>
      <div style="font-size:11px; color:#79d48f; line-height:1.45;">
        Ejecuta el mismo <strong>Revert</strong> nativo de GitHub usando tu sesión SAML activa: creará una rama <code>revert-N-...</code> y abrirá el nuevo Pull Request de reverso en otra pestaña para revisión (no hace merge directo).
      </div>
      <div class="mgg-dialog-field">
        <span>Alternativa en terminal local (Git):</span>
        <div class="mgg-dialog-cmd" id="mgg-revert-cmd">${MGG.escapeHtml(gitRevertCmd)}</div>
      </div>
      <div id="mgg-dlg-feedback" style="font-size:11.5px; color:#00f0ff; min-height:16px;"></div>
      <div class="mgg-dialog-actions">
        <button type="button" id="mgg-revert-copy-cmd" class="mgg-btn mgg-btn-sm">Copiar git revert</button>
        <a id="mgg-revert-open-pr" href="#" target="_blank" rel="noopener noreferrer" class="mgg-btn mgg-btn-sm">Abrir PR en GitHub ↗</a>
        <button type="button" id="mgg-revert-exec-btn" class="mgg-btn mgg-btn-sm mgg-btn-cyan">Ejecutar PR Revert ahora</button>
      </div>
    `;

    const prInput = box.querySelector('#mgg-pr-num-input');
    const openPrLink = box.querySelector('#mgg-revert-open-pr');
    const feedbackEl = box.querySelector('#mgg-dlg-feedback');
    const execBtn = box.querySelector('#mgg-revert-exec-btn');

    const updatePrLink = () => {
      const n = Number(prInput.value);
      if (n > 0) {
        openPrLink.href = `https://github.com/${owner}/${repo}/pull/${n}`;
        openPrLink.style.display = 'inline-flex';
      } else {
        openPrLink.style.display = 'none';
      }
    };

    prInput.addEventListener('input', updatePrLink);
    updatePrLink();

    box.querySelector('#mgg-dlg-close').addEventListener('click', closeDialog);

    box.querySelector('#mgg-revert-copy-cmd').addEventListener('click', (e) => {
      navigator.clipboard?.writeText(gitRevertCmd);
      e.target.textContent = '¡Copiado!';
      setTimeout(() => {
        e.target.textContent = 'Copiar git revert';
      }, 1200);
    });

    execBtn.addEventListener('click', async () => {
      const prNum = Number(prInput.value);
      if (!prNum || prNum <= 0) {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = 'Indica un número de Pull Request válido.';
        return;
      }

      execBtn.disabled = true;
      feedbackEl.style.color = '#00f0ff';
      feedbackEl.textContent = `Solicitando Revert del PR #${prNum} a GitHub...`;

      const res = await MGG.github.webRevertPullRequest(owner, repo, prNum);
      execBtn.disabled = false;

      if (res.ok) {
        feedbackEl.style.color = '#00ff41';
        feedbackEl.innerHTML = `PR Revert generado. <a href="${MGG.escapeHtml(
          res.url
        )}" target="_blank" rel="noopener noreferrer" style="color:#00f0ff; text-decoration:underline;">Abrir PR de reverso ↗</a>`;
        window.open(res.url, '_blank', 'noopener,noreferrer');
        callbacks.setStatus(`Revert del PR #${prNum} iniciado en GitHub.`);
      } else {
        feedbackEl.style.color = '#ff4d6d';
        feedbackEl.textContent = res.error || 'No se pudo ejecutar el PR Revert.';
      }
    });

    dialogBackdropEl.classList.add('mgg-open');
    prInput.focus();
  }

  MGG.explorer = {
    mount,
    openForCommit,
    close,
    isOpen,
    isDialogOpen,
    openCreatePrDialog,
    openCreateTagDialog,
    openDeleteTagDialog,
    openPrRevertDialog,
    closeDialog,
    openContextMenu,
    closeContextMenu,
    isContextMenuOpen,
    renderDiffHtml
  };
})();