// Synthetic Tauri IPC for local visual QA only. Inject before src/main.tsx;
// never import this file into the application or a production build.
(() => {
  const scenario = new URLSearchParams(location.search).get('scenario') || 'success';
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const history = [{
    id: 'history-demo', method: 'POST', url: '/api/orders?status=pending', status_code: 201,
    response_body: '{\n  "id": 8841,\n  "status": "pending"\n}', duration_ms: 142,
    fired_at: '2026-10-23T12:00:00Z', session_id: null,
    request_headers: [{ key: 'Content-Type', value: 'application/json' }],
    request_body: 'é🙂', response_headers: [{ key: 'content-type', value: 'application/json' },
      { key: 'set-cookie', value: 'demo=one' }, { key: 'set-cookie', value: 'demo=two' }],
  }];
  let saved = [{
    id: 'saved-demo', name: 'Create order', session_id: null, method: 'POST', url: '/api/orders?status=pending',
    headers: [{ key: 'X-Debug', value: 'yes', enabled: false }], body: '{"sku":"WIDGET-1"}', body_type: 'json',
    auth: { type: 'bearer', token: 'synthetic-token', username: '', password: '', keyName: 'X-Api-Key', keyValue: '', keyIn: 'header' },
    created_at: '2026-10-23T12:00:00Z', updated_at: '2026-10-23T12:00:00Z',
  }];
  let sequence = 0;
  let tabs = [
    { id: 'api-demo', kind: 'api', pane: 'left', ordinal: 0, session_id: null,
      state: JSON.stringify({ method: 'POST', url: '/api/orders?status=pending' }) },
    ...(scenario === 'split' ? [{ id: 'api-second', kind: 'api', pane: 'right', ordinal: 0,
      session_id: null, state: JSON.stringify({ method: 'GET', url: '/api/health' }) }] : []),
  ];
  const handlers = {
    get_startup_status: () => ({ db_error: null }),
    get_settings: () => ({ theme: 'dark', correlation_window_ms: 2000, smtp_port: 1025,
      provider: 'anthropic', model: 'demo', active_session_id: null }),
    set_setting: () => null,
    list_sessions: () => [], list_archived_sessions: () => [],
    list_tabs: () => tabs,
    create_tab: ({ input }) => { tabs.push(input); return null; },
    set_tab_state: ({ id, state }) => { tabs = tabs.map((tab) => tab.id === id ? { ...tab, state } : tab); },
    close_tab: ({ id }) => { tabs = tabs.filter((tab) => tab.id !== id); },
    move_tab: () => null,
    list_connections: () => scenario === 'no-connection' ? [] : [{ id: 'demo-connection', name: 'Synthetic local database',
      engine: 'postgres', host: 'localhost', port: 5433, database: 'demo', username: 'demo', sslmode: 'disable', has_password: false }],
    list_watched_tables: () => [], list_saved_queries: () => [],
    list_log_sources: () => [], list_emails: () => ({ emails: [], total: 0 }),
    smtp_status: () => ({ running: false, port: 1025, error: null }),
    get_provider_status: () => ({ configured: false, provider: 'anthropic', model: 'demo' }),
    list_mcp_servers: () => [],
    list_history: async () => {
      if (scenario === 'history-loading') await pause(60000);
      if (scenario === 'history-failure') throw new Error('Synthetic history failure');
      return scenario === 'empty' ? [] : history;
    },
    list_saved_requests: ({ sessionId }) => saved.filter((request) => !sessionId || request.session_id === sessionId),
    create_saved_request: ({ input }) => {
      const request = { ...input, id: `saved-${++sequence}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      saved.push(request);
      return request;
    },
    update_saved_request: ({ id, input }) => {
      const current = saved.find((request) => request.id === id);
      if (!current) throw new Error('Saved request not found');
      const request = { ...current, ...input, updated_at: new Date().toISOString() };
      saved = saved.map((old) => old.id === id ? request : old);
      return request;
    },
    rename_saved_request: ({ id, name }) => {
      const current = saved.find((request) => request.id === id);
      if (!current) throw new Error('Saved request not found');
      const request = { ...current, name, updated_at: new Date().toISOString() };
      saved = saved.map((old) => old.id === id ? request : old);
      return request;
    },
    delete_saved_request: ({ id }) => { saved = saved.filter((request) => request.id !== id); },
    run_correlated_request: async ({ request }) => {
      window.apiComposerFixture.requests.push(request);
      await pause(scenario === 'sending' ? 60000 : 300);
      if (scenario === 'request-failure') throw new Error('Synthetic request failed. Check the URL and try again.');
      const id = `demo-${++sequence}`;
      return { correlation_id: id, history_id: 'history-demo', table_diffs: [], db_error: null,
        response: { status_code: 201, headers: history[0].response_headers,
          body: scenario === 'empty' ? '' : history[0].response_body, duration_ms: 142 } };
    },
    collect_correlation_window: async () => { await pause(300); return {
      log_lines: [], log_lines_truncated: false, emails: [], emails_truncated: false,
    }; },
  };
  window.apiComposerFixture = { scenario, requests: [], saved: () => saved };
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args = {}) => {
      if (!Object.hasOwn(handlers, command)) throw new Error(`Unstubbed QA command: ${command}`);
      return handlers[command](args);
    },
    transformCallback: (callback) => callback,
    convertFileSrc: (path) => path,
  };
})();
