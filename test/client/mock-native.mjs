export async function installNativeMock(page, options = {}) {
  const permissions = options.permissions || ['*'];
  const user = { id: 'test-user', username: '联调管理员', permissions, disabled: false };
  const control = { requests: [], authenticated: options.authenticated !== false, unauthorized: false, downloads: [], saves: [], exportEvents: [], configs: new Map(), jobs: new Map(), jobErrors: new Map(), jobDelays: new Map(), jobGates: new Map(), jobCompletions: [], failNext: undefined };
  control.user = user;
  control.update = { available: false, currentVersion: '0.1.0', configured: false };
  const fields = [
    { name: '编号', dataType: 'BIGINT', nullable: false, primaryKey: true, ordinal: 0 },
    { name: '地市', dataType: 'VARCHAR', nullable: false, ordinal: 1 },
    { name: '产品', dataType: 'VARCHAR', nullable: true, ordinal: 2 },
    { name: '金额', dataType: 'DECIMAL(18,2)', nullable: true, ordinal: 3 },
  ];
  control.rows = [
    { 编号: '9007199254740993', 地市: '贵阳', 产品: '权益产品 A', 金额: '1280.50' },
    { 编号: '9007199254740994', 地市: '遵义', 产品: '权益产品 B', 金额: '960.00' },
    { 编号: '9007199254740995', 地市: '毕节', 产品: '权益产品 A', 金额: '2310.80' },
    { 编号: '9007199254740996', 地市: '六盘水', 产品: null, 金额: '800.00' },
  ];
  const saved = (id, kind, name, body) => ({ id, kind, name, body, ownerId: user.id, version: 1, updatedAt: '2026-10-23T01:00:00Z' });
  for (const config of [
    saved('daily-query', 'query', '权益明细取数', { datasetId: 'rights-db', permissions: [], query: { table: '权益明细', limit: 100 } }),
    saved('daily-report', 'report', '权益日常明细', { enabled: true, permissions: [], definitionIds: ['daily-query'], primaryDefinitionId: 'daily-query', columns: [], parameters: [], pageSize: 20 }),
    saved('daily-board', 'dashboard', '权益运营看板', { enabled: true, permissions: [], definitionIds: ['daily-query'], widgets: [{ id: 'detail', type: 'table', title: '地市数据', definitionId: 'daily-query' }], refreshSeconds: 0 }),
    saved('daily-bulletin', 'h5', '权益日报', { enabled: true, permissions: [], definitionIds: ['daily-query'], html: '<main><h2>权益日报</h2><div id="result"></div><script>window.rightData.query("daily-query").then(result => document.querySelector("#result").textContent = "已加载 " + result.rows.length + " 条记录")</script>' }),
    saved('daily-screen', 'screen', '权益数据大屏', { enabled: true, permissions: [], definitionIds: ['daily-query'], parameters: [] }),
    saved('secondary-screen', 'screen', '备用数据大屏', { enabled: true, permissions: [], definitionIds: ['daily-query'], parameters: [] }),
    saved('daily-menu', 'menu', '权益日常明细', { enabled: true, permissions: [], parentId: '', order: 1, resourceId: 'daily-report', resourceKind: 'report' }),
    saved('board-menu', 'menu', '权益运营看板', { enabled: true, permissions: [], parentId: '', order: 2, resourceId: 'daily-board', resourceKind: 'dashboard' }),
    saved('bulletin-menu', 'menu', '权益日报', { enabled: true, permissions: [], parentId: '', order: 3, resourceId: 'daily-bulletin', resourceKind: 'h5' }),
    saved('screen-menu', 'menu', '权益数据大屏', { enabled: true, permissions: [], parentId: '', order: 4, resourceId: 'daily-screen', resourceKind: 'screen' }),
  ]) control.configs.set(config.id, config);
  const screenVersion = (version, marker, sizeBytes = 1024) => ({
    screenId: 'daily-screen', version, entry: 'index.html', containerApiVersion: 1,
    files: [{ path: 'index.html', size: 200, sha256: marker.repeat(64) }, { path: 'screen.css', size: 80, sha256: marker.repeat(64) }, { path: 'screen.js', size: 300, sha256: marker.repeat(64) }],
    sha256: marker.repeat(64), sizeBytes, createdAt: `2026-10-${version === '1.0.0' ? '20' : '22'}T00:00:00Z`,
    downloadUrl: `/api/v1/screens/daily-screen/versions/${version}/download`,
  });
  control.screenVersions = new Map([['2.0.0', screenVersion('2.0.0', 'b', 2048)], ['1.0.0', screenVersion('1.0.0', 'a')]]);
  control.screenUploadBytes = new Map();
  control.screenPublication = { publishedVersion: control.screenVersions.get('1.0.0'), publishRevision: 1, publishedAt: '2026-10-21T00:00:00Z' };
  const screenEntry = version => `<!doctype html><html><head><link rel="stylesheet" href="./screen.css"></head><body><main data-screen-version="${version}"><h1>大屏 ${version}</h1><div id="bound-query">等待查询</div><div id="forbidden-query">等待拒绝</div><div id="external-fetch">等待阻止</div><div id="native-ipc"></div><script type="module" src="./screen.js"></script></main></body></html>`;
  control.screenEntries = new Map([...control.screenVersions.keys()].map(version => [version, screenEntry(version)]));
  control.screenPrepares = [];
  control.screenReleases = [];
  control.screenListCompletions = [];
  control.previewOpens = [];
  control.screenTokenSequence = 0;
  control.files = [{ id: 'guide', name: '权益口径说明.txt', size: 3200, ownerId: user.id, mediaType: 'text/plain', sha256: 'a'.repeat(64), updatedAt: '2026-10-23T01:00:00Z' }];
  control.settings = { serverUrl: 'http://127.0.0.1:8003', discoveryUrl: '', allowPublicRelay: false };
  const state = () => ({ settings: control.settings, connection: { mode: 'direct', instanceId: 'test-instance', apiVersion: '1', ready: true }, session: { authenticated: control.authenticated, user: control.authenticated ? user : undefined, remember: true } });
  const result = data => ({ status: 200, headers: {}, data: { code: 'ok', message: '', data, requestId: 'test-request' } });
  const query = () => ({ fields, rows: control.rows, total: control.queryTotal ?? control.rows.length, truncated: control.queryTruncated === true });
  control.query = query;
  await page.exposeFunction('__rightdataTestNative', async (command, args) => {
    const input = args?.request || {};
    control.requests.push({ command, ...input });
    try {
      if (control.failNext) { const error = control.failNext; control.failNext = undefined; throw error; }
      if (command === 'transport_get_state') return { ok: true, value: state() };
      if (command === 'client_update_check') return { ok: true, value: control.update };
      if (command === 'export_event_status') return { ok: true, value: { pending: 0, rejected: 0 } };
      if (command === 'client_update_download') return { ok: true, value: { verified: true, version: input.version } };
      if (command === 'client_update_install') return { ok: true, value: { started: true } };
      if (command === 'network_service_get_state') return { ok: true, value: { running: true, enabled: true, autoStart: false, deviceId: 'test-device', mode: 'direct', ready: true } };
      if (command === 'network_service_set_enabled') return { ok: true, value: { running: true, enabled: input.enabled, autoStart: false, deviceId: 'test-device', mode: input.enabled ? 'direct' : 'disconnected', ready: input.enabled } };
      if (command === 'network_service_set_autostart') return { ok: true, value: { running: true, enabled: true, autoStart: input.autoStart, deviceId: 'test-device', mode: 'direct', ready: true } };
      if (command === 'transport_probe') return { ok: true, value: { service: 'RightData', instanceId: 'test-instance', apiVersion: '1', ready: true, mode: 'direct', latencyMs: 4 } };
      if (command === 'transport_configure') { control.settings = input; return { ok: true, value: state() }; }
      if (command === 'auth_restore') return { ok: true, value: { authenticated: control.authenticated, user: control.authenticated ? user : undefined } };
      if (command === 'auth_login') {
        if (input.password === 'wrong') throw { status: 401, code: 'invalid_credentials', message: '账号或密码不正确' };
        control.authenticated = true; return { ok: true, value: { authenticated: true, user, expiresIn: 900, remember: input.remember } };
      }
      if (command === 'auth_logout') { control.authenticated = false; return { ok: true, value: { loggedOut: true, remoteRevoked: true } }; }
      if (command === 'api_download') { control.downloads.push(input); return { ok: true, value: { saved: true, path: `test/${input.suggestedName}`, size: 32 } }; }
      if (command === 'desktop_save_file') { control.saves.push(input); return { ok: true, value: { saved: true, path: `test/${input.suggestedName}` } }; }
      if (command === 'export_event_enqueue') { control.exportEvents.push(input); return { ok: true, value: {} }; }
      if (command === 'preview_open') { control.previewOpens.push(input); return { ok: true, value: { created: true, label: 'preview-test' } }; }
      if (command === 'screen_prepare') {
        if (control.failNextScreenPrepare) { const error = control.failNextScreenPrepare; control.failNextScreenPrepare = undefined; throw error; }
        const version = input.preview ? input.version : control.screenPublication.publishedVersion?.version;
        const record = control.screenVersions.get(version);
        if (!record) throw { status: 404, code: 'screen_version_not_found', message: '大屏版本不存在' };
        const prepared = { resourceId: input.resourceId, version, entryHtml: control.screenEntries.get(version), baseUrl: `http://rd-screen.localhost/screen-${++control.screenTokenSequence}/`, cacheHit: false, sha256: record.sha256 };
        control.screenPrepares.push({ ...input, result: prepared });
        return { ok: true, value: prepared };
      }
      if (command === 'screen_release') { control.screenReleases.push(input.baseUrl); return { ok: true, value: {} }; }
      if (command === 'api_upload') {
        if (input.path === '/api/v1/uploads') return { ok: true, value: result({ uploadId: 'test-upload', sizeBytes: input.bytes.length, sha256: 'b'.repeat(64), expiresAt: '2026-10-24T00:00:00Z' }) };
        if (input.path === '/api/v1/screens/daily-screen/versions') {
          const version = control.nextScreenUploadVersion || input.fileName.match(/(\d+\.\d+\.\d+)/)?.[1] || '3.0.0';
          control.nextScreenUploadVersion = undefined;
          const bytes = JSON.stringify(input.bytes);
          if (control.screenUploadGate) await control.screenUploadGate;
          if (control.screenUploadDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, control.screenUploadDelayMs));
          const existing = control.screenVersions.get(version);
          if (existing) {
            if (control.screenUploadBytes.get(version) === bytes) return { ok: true, value: result(existing) };
            throw { status: 409, code: 'screen_version_exists', message: '相同版本已存在且内容不同' };
          }
          const record = screenVersion(version, 'c', input.bytes.length);
          control.screenVersions.set(version, record); control.screenUploadBytes.set(version, bytes);
          control.screenEntries.set(version, screenEntry(version));
          return { ok: true, value: result(record) };
        }
        const file = { id: 'uploaded-file', name: input.fileName, size: input.bytes.length, mediaType: input.mediaType, updatedAt: new Date().toISOString(), ownerId: user.id }; control.files.push(file);
        return { ok: true, value: result(file) };
      }
      if (command !== 'api_request') throw { message: `Unmocked native command ${command}` };
      if (control.unauthorized) throw { status: 401, code: 'unauthenticated', message: '登录已失效' };
      const url = new URL(input.path, 'http://test');
      const path = decodeURIComponent(url.pathname);
      let data;
      if (path === '/api/v1/auth/me') data = user;
      else if (path === '/api/v1/menus') data = { items: [...control.configs.values()].filter(config => config.kind === 'menu').map(config => ({ id: config.id, name: config.name, ...config.body })) };
      else if (path === '/api/v1/datasets') data = { datasets: [{ id: 'rights-db', name: '权益业务库' }] };
      else if (path.endsWith('/tables')) data = { tables: ['权益明细'] };
      else if (path.endsWith('/schema')) data = { fields };
      else if (path.endsWith('/query') || path.endsWith('/sql:query')) data = query();
      else if (path.endsWith('/records:mutate')) data = { inserted: 0, updated: 1, deleted: 0 };
      else if (path.endsWith('/schema:mutate')) data = { success: true };
      else if (path === '/api/v1/configs') data = { items: [...control.configs.values()].filter(config => !url.searchParams.get('kind') || config.kind === url.searchParams.get('kind')) };
      else if (path === '/api/v1/screens/daily-screen/versions') {
        const offset = Number(url.searchParams.get('offset') || 0); const limit = Number(url.searchParams.get('limit') || 20);
        const snapshot = { items: [...control.screenVersions.values()].slice(offset, offset + limit), ...control.screenPublication };
        if (offset > 0 && control.screenListDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, control.screenListDelayMs));
        control.screenListCompletions.push(offset);
        data = snapshot;
      }
      else if (path === '/api/v1/screens/secondary-screen/versions') data = { items: [], publishedVersion: null, publishRevision: 0, publishedAt: null };
      else if (path === '/api/v1/screens/daily-screen/publish' && input.method === 'POST') {
        if (control.failNextScreenPublishConflict) {
          control.failNextScreenPublishConflict = false;
          control.screenPublication = { ...control.screenPublication, publishRevision: control.screenPublication.publishRevision + 1 };
          throw { status: 409, code: 'version_conflict', message: '发布版本已更新' };
        }
        if (input.body.expectedRevision !== control.screenPublication.publishRevision) throw { status: 409, code: 'version_conflict', message: '发布版本已更新' };
        const publishedVersion = control.screenVersions.get(input.body.version);
        if (!publishedVersion) throw { status: 404, code: 'screen_version_not_found', message: '大屏版本不存在' };
        control.screenPublication = { publishedVersion, publishRevision: control.screenPublication.publishRevision + 1, publishedAt: new Date().toISOString() };
        data = control.screenPublication;
      }
      else if (path.startsWith('/api/v1/configs/') && input.method === 'PUT') {
        const id = path.split('/')[4]; const old = control.configs.get(id);
        if (old && old.version !== input.body.version) throw { code: 'version_conflict', status: 409, message: '配置已更新，请重新读取后保存' };
        data = { ...input.body, id, version: (old?.version || 0) + 1, ownerId: user.id, updatedAt: new Date().toISOString() }; control.configs.set(id, data);
      }
      else if (path.startsWith('/api/v1/configs/') && input.method === 'DELETE') { control.configs.delete(path.split('/')[4]); data = {}; }
      else if (path === '/api/v1/resources/preview') data = { body: input.body.body, data: input.body.definitionId ? query() : undefined };
      else if (path.endsWith('/execute')) data = query();
      else if (path.startsWith('/api/v1/resources/')) {
        const resource = control.configs.get(path.split('/')[4]);
        data = resource?.kind === 'screen' ? { ...resource, ...control.screenPublication } : resource;
      }
      else if (path === '/api/v1/files') data = { items: control.files };
      else if (path.startsWith('/api/v1/files/')) { const id = path.split('/')[4]; if (input.method === 'PATCH') Object.assign(control.files.find(file => file.id === id), input.body); if (input.method === 'DELETE') control.files = control.files.filter(file => file.id !== id); data = {}; }
      else if (path === '/api/v1/connections') data = { items: [{ id: 'rights-db', name: '权益业务库', fileId: 'db-file', createdAt: '2026-10-23T00:00:00Z' }] };
      else if (path === '/api/v1/data-files') data = { items: [{ id: 'db-file', name: 'rights.duckdb', kind: 'business', ownerId: user.id, size: 1048576, hasPassword: true, createdAt: '2026-10-23T00:00:00Z', connections: [{ id: 'rights-db', name: '权益业务库' }] }] };
      else if (path === '/api/v1/users') data = { items: [user, { id: 'analyst', username: '数据分析员', permissions: ['data.read', 'resources.read'], disabled: false }] };
      else if (path.endsWith('/grants')) data = { items: [] };
      else if (path === '/api/v1/logs' || path === '/api/v1/query-logs') data = { items: control.logs || [{ id: 'event-1', createdAt: '2026-10-23T00:00:00Z', actorId: user.id, category: url.searchParams.get('category'), action: 'query', target: '权益明细', outcome: 'success', durationMs: 18, requestId: 'audit-test-id', source: 'workbench', sqlTemplate: 'SELECT * FROM "权益明细"' }] };
      else if (path === '/api/v1/import-jobs') data = { jobId: 'import-test', state: 'queued' };
      else if (path === '/api/v1/export-jobs') data = { jobId: 'export-test', state: 'queued' };
      else if (path.endsWith('/backups') && input.method === 'POST') data = { jobId: 'backup-test', state: 'queued' };
      else if (path.startsWith('/api/v1/jobs/')) {
        const id = path.split('/')[4];
        const gate = control.jobGates.get(id);
        if (gate) await gate;
        const delay = control.jobDelays.get(id);
        if (delay) await new Promise(resolveDelay => setTimeout(resolveDelay, delay));
        const jobError = control.jobErrors.get(id);
        if (jobError) throw jobError;
        control.jobCompletions.push(id);
        data = control.jobs.get(id) || { id: 'import-test', kind: 'import', datasetId: 'rights-db', state: 'succeeded', progress: { phase: 'done', percent: 100 }, result: { insertedRows: 2 }, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:01Z', expiresAt: '2026-10-24T00:00:00Z' };
      }
      else throw { message: `Unmocked API ${input.method || 'GET'} ${path}` };
      return { ok: true, value: result(data) };
    } catch (error) { return { ok: false, error: typeof error === 'object' ? error : { message: String(error) } }; }
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.isTauri = true;
    window.__rightdataTestResponses = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const result = await window.__rightdataTestNative(command, args);
      if (command === 'api_request' && args?.request?.path?.startsWith('/api/v1/jobs/')) window.__rightdataTestResponses.push(args.request.path.split('/')[4]);
      if (!result.ok) throw result.error;
      return result.value;
    } };
  });
  return control;
}
