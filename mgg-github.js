(() => {
  if (window.__MGG_GITHUB_INIT__) return;
  window.__MGG_GITHUB_INIT__ = true;

  const MGG = window.MGG;
  const { state, callbacks } = MGG;

  // =====================================================================
  // CAPA 1: API DE GITHUB (MULTI-PAT + SAML SSO + AUTO-ROTACIÓN)
  // =====================================================================

  function extractSsoUrl(ssoHeader) {
    if (!ssoHeader) return 'https://github.com/settings/tokens';
    const match = String(ssoHeader).match(/url=([^\s;]+)/i);
    return match ? match[1] : 'https://github.com/settings/tokens';
  }

  function isSamlEnforcementResponse(res) {
    if (!res || res.status !== 403) return false;
    if (res.ssoHeader && String(res.ssoHeader).toLowerCase().includes('required')) return true;
    const msg = String(res.data?.message || '').toLowerCase();
    return msg.includes('saml') || msg.includes('single sign-on');
  }

  function isRateLimitResponse(res) {
    if (!res) return false;
    if (isSamlEnforcementResponse(res)) return false;
    if (res.status === 429) return true;
    if (res.status === 403) {
      if (res.rateRemaining === 0) return true;
      const msg = String(res.data?.message || '').toLowerCase();
      if (msg.includes('rate limit') || msg.includes('secondary rate') || msg.includes('abuse')) {
        return true;
      }
    }
    return false;
  }

  async function rawFetchWithToken(url, tokenValue, options = {}) {
    try {
      const method = options.method || 'GET';
      const headers = {
        Accept: 'application/vnd.github+json',
        ...(options.headers || {})
      };
      if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }

      const fetchOpts = { method, headers, cache: 'no-store' };
      if (options.body !== undefined) {
        fetchOpts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      const res = await fetch(url, fetchOpts);

      const remHeader = res.headers.get('x-ratelimit-remaining');
      const limHeader = res.headers.get('x-ratelimit-limit');
      const resetHeader = res.headers.get('x-ratelimit-reset');
      const ssoHeader = res.headers.get('x-github-sso');

      const rateRemaining = remHeader !== null ? Number(remHeader) : null;
      const rateLimit = limHeader !== null ? Number(limHeader) : null;
      const rateResetAt = resetHeader !== null ? Number(resetHeader) * 1000 : null;
      const data = res.status === 204 ? null : await res.json().catch(() => null);

      return {
        ok: res.ok,
        status: res.status,
        data,
        rateRemaining,
        rateLimit,
        rateResetAt,
        ssoHeader,
        isSaml:
          res.status === 403 &&
          ((ssoHeader && ssoHeader.toLowerCase().includes('required')) ||
            String(data?.message || '').toLowerCase().includes('saml')),
        ssoUrl: ssoHeader ? extractSsoUrl(ssoHeader) : 'https://github.com/settings/tokens'
      };
    } catch (err) {
      return { ok: false, status: 0, error: err?.message || String(err) };
    }
  }

  async function githubApiFetch(url, options = {}) {
    if (state.tokens.length === 0) {
      const res = await rawFetchWithToken(url, '', options);
      if (res.rateRemaining !== null && res.rateRemaining !== undefined) {
        state.anonRateRemaining = res.rateRemaining;
      }
      callbacks.updateRateDisplay();
      return res;
    }

    const total = state.tokens.length;
    const startIdx = Math.min(Math.max(0, state.activeTokenIndex), total - 1);

    let indices = [startIdx];
    if (state.autoRotate && total > 1) {
      const healthy = [];
      const fallback = [];
      for (let offset = 0; offset < total; offset++) {
        const idx = (startIdx + offset) % total;
        const tok = state.tokens[idx];
        if (!MGG.isTokenCurrentlyExhausted(tok) && tok.status !== 'invalid') healthy.push(idx);
        else fallback.push(idx);
      }
      indices = [...healthy, ...fallback];
    }

    let lastRes = null;

    for (const idx of indices) {
      const tok = state.tokens[idx];
      const res = await rawFetchWithToken(url, tok.value, options);
      lastRes = res;

      if (res.rateRemaining !== null && res.rateRemaining !== undefined) tok.remaining = res.rateRemaining;
      if (res.rateLimit !== null && res.rateLimit !== undefined) tok.limit = res.rateLimit;
      if (res.rateResetAt) tok.resetAt = res.rateResetAt;

      if (res.ok) {
        tok.status = 'ok';
        tok.ssoUrl = null;
        if (state.activeTokenIndex !== idx) state.activeTokenIndex = idx;
        MGG.saveGlobalTokens();
        callbacks.updateControlsUI();
        return res;
      }

      if (res.status === 0) break;

      if (isSamlEnforcementResponse(res)) {
        tok.status = 'saml';
        tok.ssoUrl = res.ssoUrl || 'https://github.com/settings/tokens';
        MGG.saveGlobalTokens();
        callbacks.updateControlsUI();
        if (state.autoRotate) continue;
        break;
      }

      if (isRateLimitResponse(res)) {
        tok.status = 'exhausted';
        tok.remaining = 0;
        MGG.saveGlobalTokens();
        callbacks.updateControlsUI();
        if (state.autoRotate) continue;
        break;
      }

      if (res.status === 401) {
        tok.status = 'invalid';
        MGG.saveGlobalTokens();
        callbacks.updateControlsUI();
        if (state.autoRotate) continue;
        break;
      }

      if ((res.status === 403 || res.status === 404) && state.autoRotate) continue;

      break;
    }

    MGG.saveGlobalTokens();
    callbacks.updateControlsUI();
    return lastRes;
  }

  async function apiFetchAllBranches(owner, repo) {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const res = await githubApiFetch(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${page}`
      );
      if (!res || !res.ok) {
        if (page === 1) return res;
        break;
      }
      const list = Array.isArray(res.data) ? res.data : [];
      for (const b of list) {
        all.push({ name: b.name, commit: { sha: b.commit?.sha || '' }, timestamp: 0 });
      }
      if (list.length < 100) break;
    }
    return { ok: true, status: 200, data: all };
  }

  async function apiFetchBranchCommits(owner, repo, branchName, limit) {
    const collected = [];
    const seen = new Set();
    const maxPages = Math.ceil(limit / 100);

    for (let page = 1; page <= maxPages; page++) {
      const perPage = Math.min(100, limit - collected.length);
      if (perPage <= 0) break;

      const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
        branchName
      )}&per_page=${perPage}&page=${page}`;
      const res = await githubApiFetch(url);
      if (!res || !res.ok) {
        if (page === 1) return res;
        break;
      }

      const list = Array.isArray(res.data) ? res.data : [];
      let added = 0;
      for (const item of list) {
        if (item?.sha && !seen.has(item.sha)) {
          seen.add(item.sha);
          collected.push(item);
          added++;
        }
      }

      if (list.length < perPage || added === 0) break;
    }

    return { ok: true, status: 200, data: collected };
  }

  async function apiFetchTags(owner, repo) {
    const collected = [];
    const seen = new Set();
    for (let page = 1; page <= 4; page++) {
      const res = await githubApiFetch(
        `https://api.github.com/repos/${owner}/${repo}/tags?per_page=100&page=${page}`
      );
      if (!res || !res.ok) {
        if (page === 1) return res;
        break;
      }
      const list = Array.isArray(res.data) ? res.data : [];
      for (const t of list) {
        if (t?.name && !seen.has(t.name)) {
          seen.add(t.name);
          collected.push({
            name: t.name,
            sha: t.commit?.sha || '',
            timestamp: 0
          });
        }
      }
      if (list.length < 100) break;
    }
    return { ok: true, status: 200, data: collected };
  }

  async function apiFetchCommitDiff(owner, repo, sha) {
    const res = await githubApiFetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`);
    if (!res || !res.ok || !res.data) {
      return {
        ok: false,
        status: res?.status || 0,
        error: res?.data?.message || res?.error || 'No se pudo obtener el diff del commit vía API.'
      };
    }

    const rawFiles = Array.isArray(res.data.files) ? res.data.files : [];
    const files = rawFiles.map((f) => ({
      filename: f.filename || '',
      previousFilename: f.previous_filename || '',
      status: normalizeFileStatus(f.status),
      additions: Number(f.additions) || 0,
      deletions: Number(f.deletions) || 0,
      patch: f.patch || '',
      blobUrl:
        f.blob_url ||
        `https://github.com/${owner}/${repo}/blob/${sha}/${MGG.encodeBranchPath(f.filename || '')}`
    }));

    const stats = {
      additions: res.data.stats?.additions ?? files.reduce((a, f) => a + f.additions, 0),
      deletions: res.data.stats?.deletions ?? files.reduce((a, f) => a + f.deletions, 0),
      total: files.length
    };

    return { ok: true, files, stats };
  }

  async function apiFetchFileHistory(owner, repo, sha, filePath) {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
      sha
    )}&path=${encodeURIComponent(filePath)}&per_page=40`;
    const res = await githubApiFetch(url);
    if (!res || !res.ok || !Array.isArray(res.data)) {
      return {
        ok: false,
        error: res?.data?.message || res?.error || 'No se pudo cargar el historial del archivo.'
      };
    }

    const commits = res.data.map((item) => {
      const dateStr = item.commit?.committer?.date || item.commit?.author?.date || '';
      const msg = item.commit?.message || '';
      return {
        sha: item.sha,
        shortSha: item.sha.slice(0, 7),
        message: msg,
        subject: msg.split('\n')[0],
        author: item.author?.login || item.commit?.author?.name || 'Desconocido',
        authorEmail: item.commit?.author?.email || '',
        date: dateStr,
        timestamp: MGG.parseTimestamp(dateStr),
        htmlUrl: item.html_url || `https://github.com/${owner}/${repo}/commit/${item.sha}`
      };
    });

    return { ok: true, commits };
  }

  async function apiCreateTag(owner, repo, sha, tagName, message) {
    let targetObjectSha = sha;

    if (message && message.trim()) {
      const tagObjRes = await githubApiFetch(`https://api.github.com/repos/${owner}/${repo}/git/tags`, {
        method: 'POST',
        body: {
          tag: tagName,
          message: message.trim(),
          object: sha,
          type: 'commit'
        }
      });
      if (!tagObjRes || !tagObjRes.ok) {
        return {
          ok: false,
          status: tagObjRes?.status || 0,
          isSaml: tagObjRes?.isSaml,
          error: tagObjRes?.data?.message || tagObjRes?.error || 'Error al crear objeto tag anotado.'
        };
      }
      if (tagObjRes.data?.sha) targetObjectSha = tagObjRes.data.sha;
    }

    const refRes = await githubApiFetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: {
        ref: `refs/tags/${tagName}`,
        sha: targetObjectSha
      }
    });

    if (!refRes || !refRes.ok) {
      return {
        ok: false,
        status: refRes?.status || 0,
        isSaml: refRes?.isSaml,
        error: refRes?.data?.message || refRes?.error || 'Error al crear referencia de tag.'
      };
    }

    return {
      ok: true,
      url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`
    };
  }

  async function apiDeleteTag(owner, repo, tagName) {
    const encodedTag = MGG.encodeBranchPath(tagName);
    const res = await githubApiFetch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/tags/${encodedTag}`,
      { method: 'DELETE' }
    );

    if (!res || (!res.ok && res.status !== 204)) {
      return {
        ok: false,
        status: res?.status || 0,
        isSaml: res?.isSaml,
        error: res?.data?.message || res?.error || `Error HTTP ${res?.status || 0} al eliminar el tag.`
      };
    }

    return { ok: true };
  }

  async function apiCreatePullRequest(owner, repo, head, base, title, body, draft = false) {
    const res = await githubApiFetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: {
        title: title.trim(),
        head,
        base,
        body: body || '',
        draft: Boolean(draft)
      }
    });

    if (!res || !res.ok) {
      const detailErrors = Array.isArray(res?.data?.errors)
        ? res.data.errors
            .map((e) => e?.message || e?.code)
            .filter(Boolean)
            .join(' | ')
        : '';
      const baseMsg = res?.data?.message || res?.error || `Error HTTP ${res?.status || 0} al crear PR.`;
      return {
        ok: false,
        status: res?.status || 0,
        isSaml: res?.isSaml,
        error: detailErrors ? `${baseMsg}: ${detailErrors}` : baseMsg
      };
    }

    return {
      ok: true,
      number: res.data?.number || null,
      url: res.data?.html_url || `https://github.com/${owner}/${repo}/pulls`
    };
  }

  async function checkAllTokensRateLimit() {
    if (state.tokens.length === 0) {
      callbacks.setStatus('No hay PATs guardados para verificar.');
      return;
    }

    callbacks.setStatus(`Verificando cuotas de ${state.tokens.length} PAT(s)...`);

    await Promise.all(
      state.tokens.map(async (tok) => {
        const res = await rawFetchWithToken('https://api.github.com/rate_limit', tok.value);
        if (res.ok && res.data?.resources?.core) {
          const core = res.data.resources.core;
          tok.remaining = core.remaining;
          tok.limit = core.limit;
          tok.resetAt = core.reset ? core.reset * 1000 : null;
          if (tok.status !== 'saml') {
            tok.status = core.remaining === 0 ? 'exhausted' : 'ok';
          }
        } else if (res.status === 401) {
          tok.status = 'invalid';
          tok.remaining = null;
        } else if (isRateLimitResponse(res)) {
          tok.status = 'exhausted';
          tok.remaining = 0;
        }
      })
    );

    MGG.saveGlobalTokens();
    callbacks.updateControlsUI();
    callbacks.setStatus('Cuotas de PATs actualizadas.');
  }

  // =====================================================================
  // CAPA 2: SESIÓN WEB DE GITHUB (SAML SSO / COOKIES DEL NAVEGADOR)
  // =====================================================================

  function normalizeFileStatus(raw) {
    const s = String(raw || '').toLowerCase();
    if (s.startsWith('add') || s === 'a') return 'A';
    if (s.startsWith('rem') || s.startsWith('del') || s === 'd') return 'D';
    if (s.startsWith('ren') || s === 'r') return 'R';
    return 'M';
  }

  function buildCompareUrl(owner, repo, head, base, title = '', body = '') {
    const baseUrl = `https://github.com/${owner}/${repo}/compare/${MGG.encodeBranchPath(
      base
    )}...${MGG.encodeBranchPath(head)}`;
    const params = new URLSearchParams();
    params.set('expand', '1');
    if (title && title.trim()) params.set('title', title.trim());
    if (body && body.trim()) params.set('body', body.trim());
    return `${baseUrl}?${params.toString()}`;
  }

  function parseEmbeddedReactData(html, expectedKeys = []) {
    if (!html) return null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const scripts = Array.from(doc.querySelectorAll('script[type="application/json"]'));

      if (expectedKeys.length > 0) {
        for (const s of scripts) {
          const txt = s.textContent || '';
          if (expectedKeys.some((k) => txt.includes(`"${k}"`))) {
            try {
              return JSON.parse(txt);
            } catch (_) {
              // continuar
            }
          }
        }
      }

      const appScript = scripts.find(
        (s) => (s.getAttribute('data-target') || '') === 'react-app.embeddedData'
      );
      if (appScript) {
        try {
          return JSON.parse(appScript.textContent || '');
        } catch (_) {
          // continuar
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  async function webFetchJsonOrEmbedded(url, expectedKeys = []) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json().catch(() => null);
        if (data) return { ok: true, status: res.status, data, html: null };
      }

      let html = '';
      if (res.ok && contentType.includes('text/html')) {
        html = await res.text();
      } else {
        const htmlRes = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          cache: 'no-store'
        });
        if (!htmlRes.ok) return { ok: false, status: htmlRes.status, data: null, html: null };
        html = await htmlRes.text();
      }

      const embedded = parseEmbeddedReactData(html, expectedKeys);
      return { ok: true, status: 200, data: embedded, html };
    } catch (err) {
      return { ok: false, status: 0, error: err?.message || String(err) };
    }
  }

  function extractHeadsFromNetworkMeta(meta, owner, repo) {
    const heads = [];
    if (!meta || typeof meta !== 'object') return heads;

    if (Array.isArray(meta.heads)) {
      for (const h of meta.heads) {
        if (h?.name && h?.id) heads.push({ name: h.name, id: h.id });
      }
    }

    if (Array.isArray(meta.users)) {
      const matching = meta.users.find(
        (u) =>
          String(u?.name || '').toLowerCase() === owner.toLowerCase() &&
          String(u?.repo || '').toLowerCase() === repo.toLowerCase()
      );
      const primaryUser = matching || meta.users[0];
      if (primaryUser && Array.isArray(primaryUser.heads)) {
        for (const h of primaryUser.heads) {
          if (h?.name && h?.id) heads.push({ name: h.name, id: h.id });
        }
      }
    }

    return heads;
  }

  function extractBranchTimestamp(item) {
    if (!item || typeof item !== 'object') return 0;
    const raw =
      item.authoredDate ||
      item.committedDate ||
      item.date ||
      item.updatedAt ||
      item.createdAt ||
      item.lastCommitDate ||
      item.commit?.committedDate ||
      item.commit?.authoredDate ||
      item.commit?.date ||
      item.commit?.committer?.date ||
      item.commit?.author?.date ||
      0;
    return MGG.parseTimestamp(raw);
  }

  function extractBranchesFromPayload(json, html, owner, repo) {
    const map = new Map();

    const addBranch = (name, sha, ts) => {
      if (!name || typeof name !== 'string') return;
      const cleanName = name.trim();
      if (!cleanName) return;
      const existing = map.get(cleanName);
      if (!existing) {
        map.set(cleanName, { name: cleanName, commit: { sha: sha || '' }, timestamp: ts || 0 });
      } else {
        if (!existing.commit.sha && sha) existing.commit.sha = sha;
        if (!existing.timestamp && ts) existing.timestamp = ts;
      }
    };

    const payload = json?.payload || json?.props?.initialPayload || json;
    if (payload && typeof payload === 'object') {
      const candidateArrays = [
        payload.branches,
        payload.allBranches,
        payload.activeBranches,
        payload.staleBranches,
        payload.yoursBranches
      ];

      if (payload.defaultBranch && typeof payload.defaultBranch === 'object') {
        addBranch(
          payload.defaultBranch.name,
          payload.defaultBranch.oid || payload.defaultBranch.commit?.oid || payload.defaultBranch.sha,
          extractBranchTimestamp(payload.defaultBranch)
        );
      }

      for (const arr of candidateArrays) {
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          if (typeof item === 'string') {
            addBranch(item, '', 0);
          } else if (item && typeof item === 'object') {
            addBranch(
              item.name || item.branchName,
              item.oid || item.commit?.oid || item.commit?.sha || item.sha || '',
              extractBranchTimestamp(item)
            );
          }
        }
      }
    }

    if (map.size === 0 && html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const prefix = `/${owner}/${repo}/tree/`;
        doc.querySelectorAll(`a[href^="${prefix}"]`).forEach((a) => {
          const href = a.getAttribute('href') || '';
          const rawBranch = href.slice(prefix.length).split('?')[0].split('#')[0];
          if (rawBranch) {
            const row = a.closest('tr, li, .Box-row, [role="row"]');
            const timeEl = row?.querySelector('relative-time, time');
            const ts = MGG.parseTimestamp(timeEl?.getAttribute('datetime') || '');
            try {
              addBranch(decodeURIComponent(rawBranch), '', ts);
            } catch (_) {
              addBranch(rawBranch, '', ts);
            }
          }
        });
      } catch (_) {
        // ignorar
      }
    }

    return Array.from(map.values());
  }

  async function webFetchNetworkMeta(owner, repo) {
    try {
      const res = await fetch(`https://github.com/${owner}/${repo}/network/meta`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('json')) return null;
      return await res.json().catch(() => null);
    } catch (_) {
      return null;
    }
  }

  async function webFetchBranches(owner, repo) {
    const branchMap = new Map();

    for (let page = 1; page <= 10; page++) {
      const url = `https://github.com/${owner}/${repo}/branches/all?page=${page}`;
      const res = await webFetchJsonOrEmbedded(url, ['branches', 'allBranches', 'activeBranches']);
      if (!res.ok) {
        if (page === 1) {
          const alt = await webFetchJsonOrEmbedded(`https://github.com/${owner}/${repo}/branches`, [
            'branches',
            'activeBranches'
          ]);
          if (!alt.ok) {
            return {
              ok: false,
              status: alt.status,
              error: alt.error || 'No se pudieron leer las ramas con la sesión web.'
            };
          }
          extractBranchesFromPayload(alt.data, alt.html, owner, repo).forEach((b) =>
            branchMap.set(b.name, b)
          );
        }
        break;
      }

      const found = extractBranchesFromPayload(res.data, res.html, owner, repo);
      let addedThisPage = 0;
      for (const b of found) {
        if (!branchMap.has(b.name)) {
          branchMap.set(b.name, b);
          addedThisPage++;
        } else {
          const ex = branchMap.get(b.name);
          if (!ex.commit.sha && b.commit.sha) ex.commit.sha = b.commit.sha;
          if (!ex.timestamp && b.timestamp) ex.timestamp = b.timestamp;
        }
      }

      const payload = res.data?.payload || res.data;
      const hasMore = payload?.hasMore === true || payload?.hasNextPage === true;
      if (!hasMore && (addedThisPage === 0 || found.length < 20)) break;
    }

    const meta = await webFetchNetworkMeta(owner, repo);
    const metaHeads = extractHeadsFromNetworkMeta(meta, owner, repo);
    for (const h of metaHeads) {
      if (!branchMap.has(h.name)) {
        branchMap.set(h.name, { name: h.name, commit: { sha: h.id }, timestamp: 0 });
      } else if (!branchMap.get(h.name).commit.sha && h.id) {
        branchMap.get(h.name).commit.sha = h.id;
      }
    }

    return { ok: true, status: 200, data: Array.from(branchMap.values()) };
  }

  async function webFetchTags(owner, repo) {
    const tagMap = new Map();
    let nextUrl = `https://github.com/${owner}/${repo}/tags`;

    for (let page = 0; page < 4 && nextUrl; page++) {
      try {
        const res = await fetch(nextUrl, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          cache: 'no-store'
        });
        if (!res.ok) break;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const tagPrefix = `/${owner}/${repo}/releases/tag/`;
        const commitRx = new RegExp(
          `/${MGG.escapeRegExp(owner)}/${MGG.escapeRegExp(repo)}/commit/([0-9a-f]{7,40})`,
          'i'
        );

        const rows = doc.querySelectorAll('.Box-row, [data-testid="tag-list-item"], li');
        let foundInPage = 0;

        rows.forEach((row) => {
          const tagLink = row.querySelector(`a[href^="${tagPrefix}"]`);
          if (!tagLink) return;
          const href = tagLink.getAttribute('href') || '';
          const rawName = href.slice(tagPrefix.length).split('?')[0].split('#')[0];
          let name = (tagLink.textContent || '').trim();
          if (!name && rawName) {
            try {
              name = decodeURIComponent(rawName);
            } catch (_) {
              name = rawName;
            }
          }
          if (!name || tagMap.has(name)) return;

          let sha = '';
          const commitLink = row.querySelector('a[href*="/commit/"]');
          if (commitLink) {
            const m = (commitLink.getAttribute('href') || '').match(commitRx);
            if (m) sha = m[1].toLowerCase();
          }

          const timeEl = row.querySelector('relative-time, time');
          const ts = MGG.parseTimestamp(timeEl?.getAttribute('datetime') || '');

          tagMap.set(name, { name, sha, timestamp: ts });
          foundInPage++;
        });

        const nextLink = doc.querySelector(
          '.paginate-container a[rel="next"], a.next_page, a[href*="/tags?after="]'
        );
        const nextHref = nextLink?.getAttribute('href');
        if (foundInPage > 0 && nextHref && nextHref.includes('after=')) {
          nextUrl = nextHref.startsWith('http') ? nextHref : `https://github.com${nextHref}`;
        } else {
          nextUrl = null;
        }
      } catch (_) {
        break;
      }
    }

    return { ok: true, status: 200, data: Array.from(tagMap.values()) };
  }

  async function webFetchNetworkData(owner, repo, desiredDepth) {
    const parentsMap = new Map();
    const commitsMap = new Map();
    const headsMap = new Map();

    const meta = await webFetchNetworkMeta(owner, repo);
    if (!meta) return { parentsMap, commitsMap, headsMap };

    for (const h of extractHeadsFromNetworkMeta(meta, owner, repo)) {
      headsMap.set(h.name, h.id);
    }

    if (!meta.nethash) return { parentsMap, commitsMap, headsMap };

    const datesLen = Array.isArray(meta.dates) ? meta.dates.length : 0;
    const focus = typeof meta.focus === 'number' ? meta.focus : datesLen > 0 ? datesLen - 1 : 0;
    const maxIndex = datesLen > 0 ? Math.min(focus, datesLen - 1) : focus;

    const chunkWidth = 100;
    const maxChunks = Math.min(18, Math.max(4, Math.ceil(desiredDepth / chunkWidth)));

    const windows = [];
    for (let i = 0; i < maxChunks; i++) {
      const end = maxIndex - i * chunkWidth;
      const start = Math.max(0, end - chunkWidth + 1);
      if (end < 0) break;
      windows.push({ start, end });
      if (start === 0) break;
    }

    for (let b = 0; b < windows.length; b += 4) {
      const batch = windows.slice(b, b + 4);
      const batchResults = await Promise.all(
        batch.map(async ({ start, end }) => {
          try {
            const url = `https://github.com/${owner}/${repo}/network/chunk?nethash=${encodeURIComponent(
              meta.nethash
            )}&start=${start}&end=${end}`;
            const res = await fetch(url, {
              method: 'GET',
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
              cache: 'no-store'
            });
            if (!res.ok) return [];
            const chunk = await res.json().catch(() => null);
            return Array.isArray(chunk?.commits) ? chunk.commits : [];
          } catch (_) {
            return [];
          }
        })
      );

      let totalInBatch = 0;
      for (const commits of batchResults) {
        totalInBatch += commits.length;
        for (const c of commits) {
          const sha = c.id || c.oid || c.sha;
          if (!sha) continue;

          const pShas = Array.isArray(c.parents)
            ? c.parents
                .map((p) => (Array.isArray(p) ? p[0] : typeof p === 'string' ? p : p?.oid || p?.sha))
                .filter((p) => typeof p === 'string' && /^[0-9a-f]{40}$/i.test(p) && p !== sha)
            : [];

          if (pShas.length > 0) parentsMap.set(sha, pShas);

          const authorName = c.login || c.author || 'Desconocido';
          const dateStr = c.date || '';

          if (!commitsMap.has(sha)) {
            commitsMap.set(sha, {
              sha,
              commit: {
                message: c.message || '',
                committer: { date: dateStr },
                author: { name: authorName, date: dateStr }
              },
              author: { login: authorName },
              html_url: `https://github.com/${owner}/${repo}/commit/${sha}`,
              parents: pShas.map((p) => ({ sha: p }))
            });
          }
        }
      }

      if (totalInBatch === 0) break;
    }

    return { parentsMap, commitsMap, headsMap };
  }

  function walkNetworkBranchCommits(headSha, networkCommitsMap, limit) {
    if (!headSha || !networkCommitsMap || !networkCommitsMap.has(headSha)) return [];
    const out = [];
    const visited = new Set();
    const queue = [headSha];

    while (queue.length > 0 && out.length < limit) {
      queue.sort((a, b) => {
        const ta = MGG.parseTimestamp(networkCommitsMap.get(a)?.commit?.committer?.date);
        const tb = MGG.parseTimestamp(networkCommitsMap.get(b)?.commit?.committer?.date);
        return tb - ta;
      });
      const sha = queue.shift();
      if (visited.has(sha)) continue;
      visited.add(sha);

      const node = networkCommitsMap.get(sha);
      if (!node) continue;
      out.push(node);

      for (const p of node.parents || []) {
        if (p?.sha && networkCommitsMap.has(p.sha) && !visited.has(p.sha)) {
          queue.push(p.sha);
        }
      }
    }

    return out;
  }

  function extractParentShasFromValue(val, selfSha) {
    if (!Array.isArray(val) || val.length === 0) return [];
    const out = [];
    const selfLower = String(selfSha || '').toLowerCase();

    for (const item of val) {
      let cand = null;
      if (typeof item === 'string') {
        const m = item.match(/([0-9a-f]{40})/i);
        if (m) cand = m[1].toLowerCase();
      } else if (Array.isArray(item) && typeof item[0] === 'string') {
        const m = item[0].match(/([0-9a-f]{40})/i);
        if (m) cand = m[1].toLowerCase();
      } else if (item && typeof item === 'object') {
        const raw = item.oid || item.sha || item.id || item.commitOid || item.url || item.path || '';
        const m = String(raw).match(/([0-9a-f]{40})/i);
        if (m) cand = m[1].toLowerCase();
      }

      if (cand && cand !== selfLower && !out.includes(cand)) out.push(cand);
    }

    return out;
  }

  function findParentsInCommitJson(root, selfSha) {
    if (!root || typeof root !== 'object') return [];
    const visited = new WeakSet();
    const parentKeyRegex = /^parent(s|oids|_oids|commits|_commits|shas|_shas)$/i;
    let best = [];

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 9 || visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object') walk(item, depth + 1);
        }
        return;
      }

      for (const key of Object.keys(node)) {
        const val = node[key];
        if (parentKeyRegex.test(key) && Array.isArray(val)) {
          const parsed = extractParentShasFromValue(val, selfSha);
          if (parsed.length > best.length) {
            best = parsed;
            if (best.length >= 2) return;
          }
        }
      }

      for (const key of Object.keys(node)) {
        if (key === 'diffLines' || key === 'diffs' || key === 'files' || key === 'hunks') continue;
        const val = node[key];
        if (val && typeof val === 'object') {
          walk(val, depth + 1);
          if (best.length >= 2) return;
        }
      }
    }

    walk(root, 0);
    return best;
  }

  function findParentsInCommitHtml(html, owner, repo, selfSha) {
    if (!html) return [];
    const selfLower = String(selfSha || '').toLowerCase();

    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const scripts = doc.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (!/parent/i.test(txt)) continue;
        try {
          const parsedJson = JSON.parse(txt);
          const found = findParentsInCommitJson(parsedJson, selfSha);
          if (found.length > 0) return found;
        } catch (_) {
          // continuar
        }
      }

      const commitHrefRegex = new RegExp(
        `/${MGG.escapeRegExp(owner)}/${MGG.escapeRegExp(repo)}/commit/([0-9a-f]{40})`,
        'i'
      );

      const directSelectors = [
        'a[data-testid="commit-parent-link"]',
        '[data-testid*="parent"] a[href*="/commit/"]',
        '.sha-block a[href*="/commit/"]'
      ];

      for (const sel of directSelectors) {
        const list = [];
        doc.querySelectorAll(sel).forEach((a) => {
          const m = (a.getAttribute('href') || '').match(commitHrefRegex);
          if (m) {
            const cand = m[1].toLowerCase();
            if (cand !== selfLower && !list.includes(cand)) list.push(cand);
          }
        });
        if (list.length > 0) return list;
      }

      const allElems = doc.querySelectorAll('div, span, p, li, section');
      for (const el of allElems) {
        if (el.children.length > 8) continue;
        const txt = (el.textContent || '').trim();
        if (/^\d+\s+parents?\b/i.test(txt) && txt.length < 180) {
          const list = [];
          const scope = el.querySelectorAll('a[href*="/commit/"]').length > 0 ? el : el.parentElement;
          scope?.querySelectorAll('a[href*="/commit/"]').forEach((a) => {
            const m = (a.getAttribute('href') || '').match(commitHrefRegex);
            if (m) {
              const cand = m[1].toLowerCase();
              if (cand !== selfLower && !list.includes(cand)) list.push(cand);
            }
          });
          if (list.length > 0) return list;
        }
      }
    } catch (_) {
      // ignorar
    }

    const rawMatch = html.match(/"parents"\s*:\s*\[([^\]]{10,400})\]/i);
    if (rawMatch) {
      const shas = [];
      const hexRx = /([0-9a-f]{40})/gi;
      let m;
      while ((m = hexRx.exec(rawMatch[1])) !== null) {
        const cand = m[1].toLowerCase();
        if (cand !== selfLower && !shas.includes(cand)) shas.push(cand);
      }
      if (shas.length > 0) return shas;
    }

    return [];
  }

  async function webFetchSingleCommitParents(owner, repo, sha) {
    const url = `https://github.com/${owner}/${repo}/commit/${sha}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });

      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json().catch(() => null);
        const found = findParentsInCommitJson(data, sha);
        if (found.length > 0) return found;
      } else if (res.ok && ct.includes('text/html')) {
        const html = await res.text();
        const found = findParentsInCommitHtml(html, owner, repo, sha);
        if (found.length > 0) return found;
      }
    } catch (_) {
      // continuar
    }

    try {
      const htmlRes = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        cache: 'no-store'
      });
      if (htmlRes.ok) {
        const html = await htmlRes.text();
        const found = findParentsInCommitHtml(html, owner, repo, sha);
        if (found.length > 0) return found;
      }
    } catch (_) {
      // ignorar
    }

    return [];
  }

  function findPaginationInfo(json, html) {
    let endCursor = null;
    let hasNextPage = null;

    if (json && typeof json === 'object') {
      const visited = new WeakSet();
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 7 || visited.has(node)) return;
        visited.add(node);

        if (typeof node.hasNextPage === 'boolean' && hasNextPage === null) {
          hasNextPage = node.hasNextPage;
        }
        if (typeof node.endCursor === 'string' && node.endCursor && !endCursor) {
          endCursor = node.endCursor;
        }
        if (typeof node.nextPageUrl === 'string' && node.nextPageUrl && !endCursor) {
          const m = node.nextPageUrl.match(/[?&]after=([^&]+)/i);
          if (m) endCursor = decodeURIComponent(m[1]);
        }

        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
        } else {
          for (const k of Object.keys(node)) {
            if (k === 'commitGroups' || k === 'commits') continue;
            const v = node[k];
            if (v && typeof v === 'object') walk(v, depth + 1);
          }
        }
      };
      walk(json, 0);
    }

    if (!endCursor && html) {
      const m = html.match(/href="[^"]*[?&]after=([^"&]+)[^"]*"/i);
      if (m) {
        const ampEsc = String.fromCharCode(38) + 'amp;';
        endCursor = decodeURIComponent(m[1]).split(ampEsc).join(String.fromCharCode(38));
      }
    }

    return { endCursor, hasNextPage };
  }

  function findCommitObjectsInJson(root) {
    const found = [];
    const seenShas = new Set();
    const visited = new WeakSet();

    function pushCommit(c) {
      if (!c || typeof c !== 'object') return;
      const sha = c.oid || c.sha || c.id;
      if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha)) return;
      const hasCommitField =
        'shortMessage' in c ||
        'messageHeadline' in c ||
        'committedDate' in c ||
        'authoredDate' in c ||
        'shortMessageMarkdownLink' in c ||
        'shortMessageHtmlLink' in c ||
        (typeof c.message === 'string' && ('author' in c || 'authors' in c || 'committer' in c));
      if (!hasCommitField) return;
      if (seenShas.has(sha)) return;
      seenShas.add(sha);
      found.push(c);
    }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8) return;
      if (visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          pushCommit(item);
          if (item && typeof item === 'object') walk(item, depth + 1);
        }
        return;
      }

      if (Array.isArray(node.commitGroups)) {
        for (const grp of node.commitGroups) {
          if (Array.isArray(grp?.commits)) {
            for (const c of grp.commits) pushCommit(c);
          }
        }
      }

      if (Array.isArray(node.commits)) {
        for (const c of node.commits) pushCommit(c);
      }

      for (const key of Object.keys(node)) {
        const val = node[key];
        if (val && typeof val === 'object') walk(val, depth + 1);
      }
    }

    walk(root, 0);
    return found;
  }

  function extractCommitsFromHtml(html, owner, repo) {
    if (!html) return [];
    const results = [];
    const seen = new Set();
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const regex = new RegExp(
        `/${MGG.escapeRegExp(owner)}/${MGG.escapeRegExp(repo)}/commit/([0-9a-f]{40})(?:[?#].*)?$`,
        'i'
      );
      const links = doc.querySelectorAll('a[href*="/commit/"]');

      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const match = href.match(regex);
        if (!match) continue;
        const sha = match[1].toLowerCase();
        if (seen.has(sha)) continue;

        const row =
          a.closest('li, [data-testid="commit-row-item"], .TimelineItem, tr, article') ||
          a.parentElement;
        const timeEl = row?.querySelector('relative-time, time');
        const dateStr = timeEl?.getAttribute('datetime') || '';
        const authorEl = row?.querySelector(
          'a[data-hovercard-type="user"], a[href*="author="], .commit-author'
        );
        const authorName = (authorEl?.textContent || 'Desconocido').trim();

        let subject = (a.getAttribute('title') || a.textContent || '').trim();
        if (!subject || /^[0-9a-f]{7}$/i.test(subject)) {
          const msgLink = row?.querySelector(
            'h4 a, [data-testid="list-view-item-title-container"] a, .markdown-title a'
          );
          if (msgLink && msgLink.textContent.trim()) subject = msgLink.textContent.trim();
        }

        seen.add(sha);
        results.push({
          sha,
          commit: {
            message: subject || sha.slice(0, 7),
            committer: { date: dateStr },
            author: { name: authorName, date: dateStr }
          },
          author: { login: authorName },
          html_url: `https://github.com/${owner}/${repo}/commit/${sha}`,
          parents: []
        });
      }
    } catch (_) {
      // ignorar
    }
    return results;
  }

  function extractCommitsFromWebPayload(json, html, owner, repo) {
    const rawCommits = json ? findCommitObjectsInJson(json) : [];

    if (rawCommits.length > 0) {
      return rawCommits
        .map((c) => {
          const sha = c.oid || c.sha || c.id;
          if (!sha) return null;
          const firstAuthor = Array.isArray(c.authors) ? c.authors[0] : c.author;
          const authorName =
            firstAuthor?.login ||
            firstAuthor?.displayName ||
            firstAuthor?.name ||
            c.committer?.displayName ||
            'Desconocido';

          let shortMsg = c.shortMessage || c.messageHeadline || c.message || '';
          if (!shortMsg && c.shortMessageHtmlLink) {
            shortMsg =
              new DOMParser().parseFromString(c.shortMessageHtmlLink, 'text/html').body
                .textContent || '';
          }

          const bodyPlain = c.bodyMessageHtml
            ? new DOMParser().parseFromString(c.bodyMessageHtml, 'text/html').body.textContent || ''
            : c.messageBody || '';

          const fullMessage = bodyPlain.trim() ? `${shortMsg}\n\n${bodyPlain.trim()}` : shortMsg;
          const dateStr = c.committedDate || c.authoredDate || c.date || '';
          const directParents = extractParentShasFromValue(c.parents || c.parentOids || [], sha);

          return {
            sha,
            commit: {
              message: fullMessage,
              committer: { date: dateStr },
              author: { name: authorName, date: dateStr }
            },
            author: { login: authorName },
            html_url: c.url
              ? c.url.startsWith('http')
                ? c.url
                : `https://github.com${c.url}`
              : `https://github.com/${owner}/${repo}/commit/${sha}`,
            parents: directParents.map((p) => ({ sha: p }))
          };
        })
        .filter(Boolean);
    }

    return extractCommitsFromHtml(html, owner, repo);
  }

  async function webFetchBranchCommits(owner, repo, branchName, limit, networkData, branchHeadSha) {
    const collected = [];
    const seen = new Set();
    let headSha = branchHeadSha || null;
    let afterCursor = null;
    let retriedAlternateCursor = false;
    const maxPages = Math.min(35, Math.ceil(limit / 30) + 2);

    for (let page = 0; page < maxPages; page++) {
      const url = MGG.buildCommitsPageUrl(owner, repo, branchName, afterCursor);
      const res = await webFetchJsonOrEmbedded(url, ['commitGroups', 'commits']);

      if (!res.ok) {
        if (page === 0) {
          const fallbackHead = headSha || networkData?.headsMap?.get(branchName);
          const fromNet = walkNetworkBranchCommits(fallbackHead, networkData?.commitsMap, limit);
          if (fromNet.length > 0) return { ok: true, status: 200, data: fromNet };
          return { ok: false, status: res.status, error: res.error || 'Error en sesión web' };
        }
        break;
      }

      const pageCommits = extractCommitsFromWebPayload(res.data, res.html, owner, repo);
      if (pageCommits.length === 0) break;

      if (!headSha) headSha = pageCommits[0].sha;

      let added = 0;
      for (const c of pageCommits) {
        if (!seen.has(c.sha)) {
          seen.add(c.sha);
          collected.push(c);
          added++;
          if (collected.length >= limit) break;
        }
      }

      if (collected.length >= limit) break;

      if (added === 0) {
        if (!retriedAlternateCursor && headSha) {
          retriedAlternateCursor = true;
          const altCursor = `${headSha}+${collected.length - 1}`;
          if (altCursor !== afterCursor) {
            afterCursor = altCursor;
            continue;
          }
        }
        break;
      }

      retriedAlternateCursor = false;
      const { endCursor, hasNextPage } = findPaginationInfo(res.data, res.html);
      if (hasNextPage === false) break;

      const nextCursor =
        endCursor ||
        (headSha
          ? `${headSha}+${collected.length - 1}`
          : `${pageCommits[pageCommits.length - 1].sha}+0`);

      if (!nextCursor || nextCursor === afterCursor) break;
      afterCursor = nextCursor;
    }

    if (collected.length === 0) {
      const fallbackHead = headSha || networkData?.headsMap?.get(branchName);
      const fromNet = walkNetworkBranchCommits(fallbackHead, networkData?.commitsMap, limit);
      if (fromNet.length > 0) return { ok: true, status: 200, data: fromNet };
    }

    return { ok: true, status: 200, data: collected };
  }

  // =====================================================================
  // DIFFS DE COMMITS + HISTORIAL POR ARCHIVO EN SESIÓN WEB (SAML)
  // =====================================================================

  function htmlStringToPlainText(htmlStr) {
    if (!htmlStr) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlStr;
    return tmp.textContent || '';
  }

  function convertDiffLinesToPatch(diffLines) {
    if (!Array.isArray(diffLines) || diffLines.length === 0) return '';
    const out = [];

    for (const line of diffLines) {
      if (!line || typeof line !== 'object') continue;
      const type = String(line.type || '').toUpperCase();
      let rawText =
        typeof line.text === 'string'
          ? line.text
          : typeof line.html === 'string'
            ? htmlStringToPlainText(line.html)
            : '';

      if (type === 'HUNK' || rawText.startsWith('@@')) {
        if (rawText.startsWith('@@')) {
          out.push(rawText);
        } else {
          const leftNum = line.left || 1;
          const rightNum = line.right || 1;
          out.push(`@@ -${leftNum},0 +${rightNum},0 @@ ${rawText}`);
        }
      } else if (type === 'ADDITION') {
        out.push(rawText.startsWith('+') ? rawText : `+${rawText}`);
      } else if (type === 'DELETION') {
        out.push(rawText.startsWith('-') ? rawText : `-${rawText}`);
      } else if (type === 'CONTEXT' || type === 'INJECTED_CONTEXT') {
        out.push(rawText.startsWith(' ') ? rawText : ` ${rawText}`);
      } else if (rawText) {
        out.push(
          rawText.startsWith(' ') || rawText.startsWith('+') || rawText.startsWith('-')
            ? rawText
            : ` ${rawText}`
        );
      }
    }

    return out.join('\n');
  }

  function extractDiffFilesFromCommitJson(root, owner, repo, sha) {
    if (!root || typeof root !== 'object') return [];
    const visited = new WeakSet();
    const collected = new Map();

    function processEntry(entry) {
      if (!entry || typeof entry !== 'object') return;
      const path = entry.path || entry.filename || entry.newPath || entry.displayName;
      if (typeof path !== 'string' || !path) return;
      const hasDiffFields =
        Array.isArray(entry.diffLines) ||
        typeof entry.patch === 'string' ||
        typeof entry.linesAdded === 'number' ||
        typeof entry.linesDeleted === 'number' ||
        typeof entry.additions === 'number' ||
        typeof entry.status === 'string';
      if (!hasDiffFields) return;

      const patch =
        typeof entry.patch === 'string' && entry.patch
          ? entry.patch
          : convertDiffLinesToPatch(entry.diffLines);

      const additions =
        typeof entry.linesAdded === 'number'
          ? entry.linesAdded
          : typeof entry.additions === 'number'
            ? entry.additions
            : (patch.match(/^\+(?!\+\+)/gm) || []).length;

      const deletions =
        typeof entry.linesDeleted === 'number'
          ? entry.linesDeleted
          : typeof entry.deletions === 'number'
            ? entry.deletions
            : (patch.match(/^-(?!--)/gm) || []).length;

      const existing = collected.get(path);
      if (!existing || (!existing.patch && patch)) {
        collected.set(path, {
          filename: path,
          previousFilename: entry.oldPath || entry.previousFilename || '',
          status: normalizeFileStatus(entry.status || entry.changeType),
          additions,
          deletions,
          patch,
          blobUrl: `https://github.com/${owner}/${repo}/blob/${sha}/${MGG.encodeBranchPath(path)}`
        });
      }
    }

    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8 || visited.has(node)) return;
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          processEntry(item);
          if (item && typeof item === 'object') walk(item, depth + 1);
        }
        return;
      }

      const knownLists = [node.diffEntryData, node.diffEntries, node.diffs, node.files, node.diffSummaries];
      for (const list of knownLists) {
        if (Array.isArray(list)) {
          for (const item of list) processEntry(item);
        }
      }

      for (const k of Object.keys(node)) {
        if (k === 'diffLines') continue;
        const val = node[k];
        if (val && typeof val === 'object') walk(val, depth + 1);
      }
    }

    walk(root, 0);
    return Array.from(collected.values());
  }

  function extractDiffFilesFromCommitHtml(html, owner, repo, sha) {
    if (!html) return [];
    const files = [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const scripts = doc.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('"diffLines"') || txt.includes('"diffEntryData"') || txt.includes('"diffs"')) {
          try {
            const parsed = JSON.parse(txt);
            const fromJson = extractDiffFilesFromCommitJson(parsed, owner, repo, sha);
            if (fromJson.length > 0) return fromJson;
          } catch (_) {
            // continuar
          }
        }
      }

      const blocks = doc.querySelectorAll('div.file, copilot-diff-entry, [data-tagsearch-path]');
      const seenPaths = new Set();

      blocks.forEach((block) => {
        const path =
          block.getAttribute('data-tagsearch-path') ||
          block.getAttribute('data-file-path') ||
          block.querySelector('.file-info a[title]')?.getAttribute('title') ||
          block.querySelector('.file-info a')?.textContent?.trim() ||
          '';
        if (!path || seenPaths.has(path)) return;
        seenPaths.add(path);

        const patchLines = [];
        let additions = 0;
        let deletions = 0;

        block.querySelectorAll('tr').forEach((tr) => {
          const codeTd = tr.querySelector('td.blob-code, td[data-code-marker]');
          if (!codeTd) return;
          const cls = codeTd.className || '';
          const marker = codeTd.getAttribute('data-code-marker') || '';
          const txt = (codeTd.textContent || '').replace(/\r?\n/g, '');

          if (cls.includes('blob-code-hunk')) {
            patchLines.push(txt.trim());
          } else if (cls.includes('blob-code-addition') || marker === '+') {
            additions++;
            patchLines.push(txt.startsWith('+') ? txt : `+${txt}`);
          } else if (cls.includes('blob-code-deletion') || marker === '-') {
            deletions++;
            patchLines.push(txt.startsWith('-') ? txt : `-${txt}`);
          } else if (cls.includes('blob-code-context') || marker === ' ') {
            patchLines.push(txt.startsWith(' ') ? txt : ` ${txt}`);
          }
        });

        let status = 'M';
        if (additions > 0 && deletions === 0 && patchLines.some((l) => l.startsWith('@@ -0,0'))) {
          status = 'A';
        } else if (deletions > 0 && additions === 0 && patchLines.some((l) => l.includes('+0,0 @@'))) {
          status = 'D';
        }

        files.push({
          filename: path,
          previousFilename: '',
          status,
          additions,
          deletions,
          patch: patchLines.join('\n'),
          blobUrl: `https://github.com/${owner}/${repo}/blob/${sha}/${MGG.encodeBranchPath(path)}`
        });
      });
    } catch (_) {
      // ignorar
    }
    return files;
  }

  function parseRawUnifiedDiff(rawText, owner, repo, sha) {
    if (!rawText || !rawText.includes('diff --git ')) return [];
    const chunks = rawText.split(/^diff --git /m).slice(1);
    const files = [];

    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      const header = lines[0] || '';
      const m = header.match(/^a\/(.+?)\s+b\/(.+)$/);
      const oldPath = m ? m[1] : '';
      const newPath = m ? m[2] : oldPath;
      if (!newPath) continue;

      let status = 'M';
      if (chunk.includes('\nnew file mode ')) status = 'A';
      else if (chunk.includes('\ndeleted file mode ')) status = 'D';
      else if (chunk.includes('\nrename from ')) status = 'R';

      const firstHunkIdx = lines.findIndex((l) => l.startsWith('@@ '));
      const patch = firstHunkIdx !== -1 ? lines.slice(firstHunkIdx).join('\n').trimEnd() : '';
      const additions = (patch.match(/^\+(?!\+\+)/gm) || []).length;
      const deletions = (patch.match(/^-(?!--)/gm) || []).length;

      files.push({
        filename: newPath,
        previousFilename: oldPath !== newPath ? oldPath : '',
        status,
        additions,
        deletions,
        patch,
        blobUrl: `https://github.com/${owner}/${repo}/blob/${sha}/${MGG.encodeBranchPath(newPath)}`
      });
    }

    return files;
  }

  async function webFetchCommitDiff(owner, repo, sha) {
    const url = `https://github.com/${owner}/${repo}/commit/${sha}?diff=unified`;
    const res = await webFetchJsonOrEmbedded(url, ['diffEntryData', 'diffLines', 'diffs']);

    let files = [];
    if (res.ok) {
      if (res.data) {
        files = extractDiffFilesFromCommitJson(res.data, owner, repo, sha);
      }
      if (files.length === 0 && res.html) {
        files = extractDiffFilesFromCommitHtml(res.html, owner, repo, sha);
      }
    }

    if (files.length === 0 || files.every((f) => !f.patch)) {
      try {
        const htmlRes = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          cache: 'no-store'
        });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const parsedHtml = extractDiffFilesFromCommitHtml(html, owner, repo, sha);
          if (parsedHtml.length > 0) files = parsedHtml;
        }
      } catch (_) {
        // continuar
      }
    }

    if (files.length === 0) {
      try {
        const diffRes = await fetch(`https://github.com/${owner}/${repo}/commit/${sha}.diff`, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store'
        });
        if (diffRes.ok) {
          const raw = await diffRes.text();
          files = parseRawUnifiedDiff(raw, owner, repo, sha);
        }
      } catch (_) {
        // ignorar
      }
    }

    const stats = {
      additions: files.reduce((a, f) => a + f.additions, 0),
      deletions: files.reduce((a, f) => a + f.deletions, 0),
      total: files.length
    };

    return { ok: true, files, stats };
  }

  async function webFetchFileHistory(owner, repo, sha, filePath) {
    const url = MGG.buildCommitsPageUrl(owner, repo, sha, null, filePath);
    const res = await webFetchJsonOrEmbedded(url, ['commitGroups', 'commits']);
    if (!res.ok) {
      return { ok: false, error: res.error || `Error HTTP ${res.status} al cargar historial del archivo.` };
    }

    const rawList = extractCommitsFromWebPayload(res.data, res.html, owner, repo);
    const commits = rawList.map((item) => {
      const dateStr = item.commit?.committer?.date || item.commit?.author?.date || '';
      const msg = item.commit?.message || '';
      return {
        sha: item.sha,
        shortSha: item.sha.slice(0, 7),
        message: msg,
        subject: msg.split('\n')[0],
        author: item.author?.login || item.commit?.author?.name || 'Desconocido',
        authorEmail: item.commit?.author?.email || '',
        date: dateStr,
        timestamp: MGG.parseTimestamp(dateStr),
        htmlUrl: item.html_url || `https://github.com/${owner}/${repo}/commit/${item.sha}`
      };
    });

    return { ok: true, commits };
  }

  // =====================================================================
  // ESCRITURA EN SESIÓN WEB (CREAR/ELIMINAR TAG, CREAR PR Y PR REVERT)
  // =====================================================================

  async function webCreateTagViaRelease(owner, repo, sha, tagName, title, notes) {
    try {
      const formPageUrl = `https://github.com/${owner}/${repo}/releases/new?tag=${encodeURIComponent(
        tagName
      )}&target=${encodeURIComponent(sha)}`;

      const getRes = await fetch(formPageUrl, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        cache: 'no-store'
      });

      if (!getRes.ok) {
        return { ok: false, error: `No se pudo abrir el formulario de Release (HTTP ${getRes.status}).` };
      }

      const html = await getRes.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const form =
        doc.querySelector(`form[action="/${owner}/${repo}/releases"]`) ||
        doc.querySelector('form[action$="/releases"]');

      if (!form) {
        return {
          ok: false,
          error: 'No se encontró el formulario interno de Releases (¿tienes permisos de escritura en este repo?).'
        };
      }

      const tokenInput = form.querySelector('input[name="authenticity_token"]');
      if (!tokenInput || !tokenInput.value) {
        return { ok: false, error: 'No se pudo obtener el token CSRF de la sesión.' };
      }

      const params = new URLSearchParams();
      form.querySelectorAll('input[type="hidden"]').forEach((inp) => {
        if (inp.name) params.set(inp.name, inp.value || '');
      });

      params.set('authenticity_token', tokenInput.value);
      params.set('release[tag_name]', tagName);
      params.set('release[target_commitish]', sha);
      params.set('release[name]', title || tagName);
      params.set('release[body]', notes || '');
      params.set('release[draft]', '0');
      params.set('release[prerelease]', '0');
      params.set('commit', 'Publish release');

      const action = form.getAttribute('action') || `/${owner}/${repo}/releases`;
      const postUrl = action.startsWith('http') ? action : `https://github.com${action}`;

      const postRes = await fetch(postUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      if (!postRes.ok) {
        return {
          ok: false,
          error: `GitHub rechazó la creación del tag (HTTP ${postRes.status}). Verifica que el tag no exista ya.`
        };
      }

      return {
        ok: true,
        url: postRes.url || `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function webDeleteTag(owner, repo, tagName) {
    const encodedTag = MGG.encodeBranchPath(tagName);
    const candidatePages = [
      `https://github.com/${owner}/${repo}/releases/tag/${encodedTag}`,
      `https://github.com/${owner}/${repo}/tags`
    ];

    try {
      for (const pageUrl of candidatePages) {
        const getRes = await fetch(pageUrl, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { Accept: 'text/html,application/xhtml+xml' },
          cache: 'no-store'
        });
        if (!getRes.ok) continue;

        const html = await getRes.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const forms = Array.from(doc.querySelectorAll('form'));

        const deleteForm = forms.find((f) => {
          const methodInp = f.querySelector('input[name="_method"]');
          const isDelete = methodInp && String(methodInp.value || '').toLowerCase() === 'delete';
          if (!isDelete) return false;
          const action = String(f.getAttribute('action') || '');
          const decodedAction = (() => {
            try {
              return decodeURIComponent(action);
            } catch (_) {
              return action;
            }
          })();
          return (
            decodedAction.includes(`/tags/${tagName}`) ||
            decodedAction.includes(`/releases/tag/${tagName}`) ||
            (pageUrl.includes('/releases/tag/') && decodedAction.includes(`/${owner}/${repo}/releases/`))
          );
        });

        if (!deleteForm) continue;

        const tokenInput = deleteForm.querySelector('input[name="authenticity_token"]');
        if (!tokenInput || !tokenInput.value) continue;

        const params = new URLSearchParams();
        deleteForm.querySelectorAll('input').forEach((inp) => {
          if (inp.name) params.set(inp.name, inp.value || '');
        });

        const action = deleteForm.getAttribute('action') || '';
        const postUrl = action.startsWith('http') ? action : `https://github.com${action}`;

        const postRes = await fetch(postUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (postRes.ok) {
          return { ok: true };
        }

        return {
          ok: false,
          error: `GitHub rechazó la eliminación del tag "${tagName}" (HTTP ${postRes.status}).`
        };
      }

      return {
        ok: false,
        error: `No se encontró el formulario web de eliminación para "${tagName}" (verifica permisos de escritura o usa el comando Git / API con PAT).`
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function webCreatePullRequest(owner, repo, head, base, title, body, draft = false) {
    const compareUrl = buildCompareUrl(owner, repo, head, base, title, body);

    try {
      const getRes = await fetch(compareUrl, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        cache: 'no-store'
      });

      if (!getRes.ok) {
        return {
          ok: false,
          compareUrl,
          error: `No se pudo cargar la comparación ${base}...${head} (HTTP ${getRes.status}).`
        };
      }

      const html = await getRes.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const existingPrLink = doc.querySelector(
        `a.btn[href^="/${owner}/${repo}/pull/"], a[data-testid="view-pull-request-button"], .existing-pull-button[href*="/pull/"]`
      );
      if (existingPrLink) {
        const href = existingPrLink.getAttribute('href') || '';
        const existingUrl = href.startsWith('http') ? href : `https://github.com${href}`;
        return {
          ok: false,
          existingUrl,
          compareUrl,
          error: `Ya existe un Pull Request abierto entre "${head}" y "${base}".`
        };
      }

      const form =
        doc.querySelector('form#new_pull_request') ||
        doc.querySelector(`form[action="/${owner}/${repo}/pull/create"]`) ||
        doc.querySelector('form[action$="/pull/create"]');

      if (!form) {
        const pageTxt = (doc.body?.textContent || '').toLowerCase();
        if (pageTxt.includes('nothing to compare') || pageTxt.includes('identical')) {
          return {
            ok: false,
            compareUrl,
            error: `No hay diferencias entre "${head}" y "${base}" para crear un Pull Request.`
          };
        }
        return {
          ok: false,
          compareUrl,
          error: 'GitHub no mostró el formulario de creación de PR para estas ramas (puedes abrir la comparación en GitHub).'
        };
      }

      const tokenInput = form.querySelector('input[name="authenticity_token"]');
      if (!tokenInput || !tokenInput.value) {
        return {
          ok: false,
          compareUrl,
          error: 'No se pudo obtener el token CSRF de la sesión para crear el PR.'
        };
      }

      const params = new URLSearchParams();
      form.querySelectorAll('input[type="hidden"]').forEach((inp) => {
        if (inp.name) params.set(inp.name, inp.value || '');
      });

      params.set('authenticity_token', tokenInput.value);
      params.set('pull_request[title]', title.trim());
      params.set('pull_request[body]', body || '');

      if (draft) {
        params.set('draft', '1');
      }

      const action = form.getAttribute('action') || `/${owner}/${repo}/pull/create`;
      const postUrl = action.startsWith('http') ? action : `https://github.com${action}`;

      const postRes = await fetch(postUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      const finalUrl = postRes.url || '';
      const prMatch = finalUrl.match(/\/pull\/(\d+)/i);

      if (postRes.ok && prMatch) {
        return {
          ok: true,
          number: Number(prMatch[1]),
          url: finalUrl
        };
      }

      const resHtml = await postRes.text().catch(() => '');
      let ghError = '';
      if (resHtml) {
        const resDoc = new DOMParser().parseFromString(resHtml, 'text/html');
        const flashEl = resDoc.querySelector('.flash-error, .js-flash-alert, [role="alert"]');
        if (flashEl && flashEl.textContent) {
          ghError = flashEl.textContent.replace(/\s+/g, ' ').trim();
        }
      }

      return {
        ok: false,
        compareUrl,
        error:
          ghError ||
          `GitHub no confirmó la creación del PR (HTTP ${postRes.status}). Puedes completarlo desde "Abrir comparación en GitHub".`
      };
    } catch (err) {
      return { ok: false, compareUrl, error: err?.message || String(err) };
    }
  }

  async function webRevertPullRequest(owner, repo, prNumber) {
    try {
      const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
      const getRes = await fetch(prUrl, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        cache: 'no-store'
      });

      if (!getRes.ok) {
        return { ok: false, error: `No se pudo leer el PR #${prNumber} (HTTP ${getRes.status}).` };
      }

      const html = await getRes.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const revertForm =
        doc.querySelector(`form[action="/${owner}/${repo}/pull/${prNumber}/revert"]`) ||
        doc.querySelector('form[action$="/revert"]');

      if (!revertForm) {
        return {
          ok: false,
          error: `GitHub no habilitó el botón Revert en el PR #${prNumber} (puede que ya haya sido revertido, no esté mergeado o requiera revertirse manualmente).`,
          prUrl
        };
      }

      const tokenInput = revertForm.querySelector('input[name="authenticity_token"]');
      if (!tokenInput || !tokenInput.value) {
        return { ok: false, error: 'No se pudo obtener el token CSRF para revertir el PR.', prUrl };
      }

      const params = new URLSearchParams();
      revertForm.querySelectorAll('input').forEach((inp) => {
        if (inp.name) params.set(inp.name, inp.value || '');
      });

      const action = revertForm.getAttribute('action') || `/${owner}/${repo}/pull/${prNumber}/revert`;
      const postUrl = action.startsWith('http') ? action : `https://github.com${action}`;

      const postRes = await fetch(postUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      if (!postRes.ok) {
        return {
          ok: false,
          error: `Error HTTP ${postRes.status} al ejecutar el Revert del PR #${prNumber}.`,
          prUrl
        };
      }

      return { ok: true, url: postRes.url || prUrl };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // =====================================================================
  // WRAPPERS UNIFICADOS (AUTO API / SESIÓN WEB SAML)
  // =====================================================================

  async function fetchRepoTags(owner, repo) {
    let res;
    if (state.activeSource === 'web') {
      res = await webFetchTags(owner, repo);
    } else {
      res = await apiFetchTags(owner, repo);
      if ((!res || !res.ok) && state.connectionMode === 'auto') {
        res = await webFetchTags(owner, repo);
      }
    }

    if (res && res.ok && Array.isArray(res.data)) {
      state.tags = res.data;
      MGG.rebuildTagsBySha();
      return res.data;
    }
    state.tags = [];
    MGG.rebuildTagsBySha();
    return [];
  }

  async function fetchCommitDiff(owner, repo, sha) {
    if (state.explorer.commitDiffCache.has(sha)) {
      return { ok: true, ...state.explorer.commitDiffCache.get(sha) };
    }

    let res;
    if (state.activeSource === 'web') {
      res = await webFetchCommitDiff(owner, repo, sha);
    } else {
      res = await apiFetchCommitDiff(owner, repo, sha);
      if ((!res || !res.ok) && state.connectionMode === 'auto') {
        res = await webFetchCommitDiff(owner, repo, sha);
      }
    }

    if (res && res.ok) {
      state.explorer.commitDiffCache.set(sha, { files: res.files, stats: res.stats });
    }
    return res;
  }

  async function fetchFileHistory(owner, repo, sha, filePath) {
    const cacheKey = `${sha}::${filePath}`;
    if (state.explorer.fileHistoryCache.has(cacheKey)) {
      return { ok: true, commits: state.explorer.fileHistoryCache.get(cacheKey) };
    }

    let res;
    if (state.activeSource === 'web') {
      res = await webFetchFileHistory(owner, repo, sha, filePath);
    } else {
      res = await apiFetchFileHistory(owner, repo, sha, filePath);
      if ((!res || !res.ok) && state.connectionMode === 'auto') {
        res = await webFetchFileHistory(owner, repo, sha, filePath);
      }
    }

    if (res && res.ok && Array.isArray(res.commits)) {
      state.explorer.fileHistoryCache.set(cacheKey, res.commits);
    }
    return res;
  }

  async function hydrateMissingBranchDatesIfNeeded() {
    if (!state.repo || state.isFetchingBranchDates) return;
    if (!state.branchSort.startsWith('date_')) return;

    const missing = state.branches.filter((b) => !b.timestamp);
    if (missing.length === 0) return;

    state.isFetchingBranchDates = true;
    const { owner, repo } = state.repo;
    const toFetch = missing.slice(0, 40);

    try {
      for (let i = 0; i < toFetch.length; i += 6) {
        const batch = toFetch.slice(i, i + 6);
        await Promise.all(
          batch.map(async (b) => {
            if (state.activeSource === 'web') {
              const url = MGG.buildCommitsPageUrl(owner, repo, b.name, null);
              const res = await webFetchJsonOrEmbedded(url, ['commitGroups', 'commits']);
              if (res.ok) {
                const list = extractCommitsFromWebPayload(res.data, res.html, owner, repo);
                if (list.length > 0) {
                  const ts = MGG.parseTimestamp(
                    list[0].commit?.committer?.date || list[0].commit?.author?.date
                  );
                  if (ts) b.timestamp = ts;
                  if (!b.commit.sha && list[0].sha) b.commit.sha = list[0].sha;
                }
              }
            } else {
              const res = await githubApiFetch(
                `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(
                  b.name
                )}&per_page=1`
              );
              if (res?.ok && Array.isArray(res.data) && res.data[0]) {
                const c = res.data[0];
                const ts = MGG.parseTimestamp(c.commit?.committer?.date || c.commit?.author?.date);
                if (ts) b.timestamp = ts;
              }
            }
          })
        );
      }
      callbacks.renderBranchSidebar();
    } finally {
      state.isFetchingBranchDates = false;
    }
  }

  MGG.github = {
    rawFetchWithToken,
    githubApiFetch,
    apiFetchAllBranches,
    apiFetchBranchCommits,
    apiFetchTags,
    apiFetchCommitDiff,
    apiFetchFileHistory,
    apiCreateTag,
    apiDeleteTag,
    apiCreatePullRequest,
    checkAllTokensRateLimit,
    buildCompareUrl,
    webFetchJsonOrEmbedded,
    webFetchBranches,
    webFetchTags,
    webFetchNetworkMeta,
    webFetchNetworkData,
    walkNetworkBranchCommits,
    webFetchSingleCommitParents,
    webFetchBranchCommits,
    webFetchCommitDiff,
    webFetchFileHistory,
    webCreateTagViaRelease,
    webDeleteTag,
    webCreatePullRequest,
    webRevertPullRequest,
    fetchRepoTags,
    fetchCommitDiff,
    fetchFileHistory,
    hydrateMissingBranchDatesIfNeeded
  };
})();