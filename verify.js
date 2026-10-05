const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const FILE = 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/');
const OUT = __dirname;

const log = (...a) => console.log(...a);
const fails = [];
function check(name, cond, extra) {
  if (cond) log('  PASS  ' + name);
  else { log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); fails.push(name); }
}

// A CRITICAL intrusion pop-up is a modal: it deliberately intercepts pointer
// events until dismissed. Dismiss it before driving navigation, otherwise the
// harness times out on a click the operator would also be blocked from making.
function dismissAlerts(page) {
  return page.evaluate(() => { if (typeof closeAlertPop === 'function') closeAlertPop(); });
}
function haltEngine(page) {
  return page.evaluate(() => {
    if (S.sim.timer) clearInterval(S.sim.timer);
    S.sim.timer = null; S.sim.running = false;
  });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));

  log('\n=== 1. LOAD + LOGIN SCREEN ===');
  await page.goto(FILE, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  check('login card rendered', await page.locator('#login .login-card').count() === 1);
  check('demo credential chips present', await page.locator('[data-demo]').count() === 3);
  check('radar animation present', await page.locator('#login .radar .sweep').count() === 1);
  await page.screenshot({ path: path.join(OUT, 'shot-01-login.png') });

  log('\n=== 2. AUTHENTICATION ===');
  // wrong password first
  await page.fill('#lgEmail', 'operator@cidrtm.navy.in');
  await page.fill('#lgPass', 'wrong-password');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(300);
  const errText = await page.locator('#login .err').first().textContent().catch(() => '');
  check('bad passphrase rejected', /rejected/i.test(errText || ''), errText);

  // correct
  await page.click('[data-demo="operator@cidrtm.navy.in|security123"]');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(600);
  check('app shell visible after login', await page.locator('#app:not([hidden])').count() === 1);
  check('login screen hidden', await page.locator('#login[hidden]').count() === 1);

  log('\n=== 2b. SEED INTEGRITY (no hull may start inside a live geofence) ===');
  const seedBad = await page.evaluate(() => vesselsInsideAnyZone());
  check('no vessel seeded inside an active zone', seedBad.length === 0, seedBad.join(', '));
  const bufSanity = await page.evaluate(() => S.zones.filter(z => z.status === 'ACTIVE').map(z => {
    const ring = z.geometry.coordinates[0];
    const c = polygonCentroid(ring);
    return { id: z.zoneId, buffer: z.warningDistance, inradius: Math.round(distanceToPolygonEdge(c, ring)) };
  }));
  log('  buffer vs true inradius: ' + bufSanity.map(b => `${b.id} ${b.buffer}/${b.inradius}`).join('  '));
  check('every warning buffer extends beyond its polygon (APPROACHING is reachable)',
    bufSanity.every(b => b.buffer > b.inradius), JSON.stringify(bufSanity));

  log('\n=== 3. DASHBOARD ===');
  const kpi = await page.evaluate(() => {
    const g = k => { const e = document.querySelector(`[data-kpi="${k}"]`); return e ? e.textContent : null; };
    return {
      vessels: g('vessels'), alerts: g('alerts'), incidents: g('incidents'), zones: g('zones'),
      counters: document.querySelectorAll('[data-kpi]').length,
      tiles: document.querySelectorAll('.tile').length,
      charts: document.querySelectorAll('svg.chart').length,
      feed: document.querySelectorAll('.feed-item').length,
    };
  });
  log('  kpi snapshot: ' + JSON.stringify(kpi));
  check('KPI live vessels populated', +kpi.vessels === 14, String(kpi.vessels));
  check('KPI zones active = 5', +kpi.zones === 5, String(kpi.zones));
  check('KPI counters rendered (inline + status rail)', kpi.counters === 8, String(kpi.counters));
  check('dashboard tiles rendered', kpi.tiles >= 6, String(kpi.tiles));
  check('charts rendered on dashboard', kpi.charts >= 1, String(kpi.charts));
  check('activity feed populated', kpi.feed > 0, String(kpi.feed));
  await page.screenshot({ path: path.join(OUT, 'shot-02-dashboard.png'), fullPage: true });

  log('\n=== 4. LIST MANAGEMENT (vessels) ===');
  await page.click('.sidebar [data-route="vessels"]');
  await page.waitForTimeout(400);
  const rows0 = await page.locator('table.tbl tbody tr').count();
  check('vessel table rendered', rows0 > 0, String(rows0));
  await page.fill('input[data-filter="vessels"][data-k="q"]', 'ocean');
  await page.waitForTimeout(600);
  const rows1 = await page.locator('table.tbl tbody tr').count();
  const firstCell = await page.locator('table.tbl tbody tr td').first().textContent();
  check('search filters the register', rows1 >= 1 && rows1 < rows0, `${rows0} -> ${rows1}`);
  check('search hit is the right vessel', /V002/.test(firstCell || ''), firstCell);
  await page.fill('input[data-filter="vessels"][data-k="q"]', '');
  await page.waitForTimeout(600);
  await page.selectOption('select[data-filter="vessels"][data-k="auth"]', 'UNAUTHORIZED');
  await page.waitForTimeout(400);
  const unauth = await page.locator('table.tbl tbody tr').count();
  check('authorisation filter works', unauth === 4, String(unauth));
  await page.selectOption('select[data-filter="vessels"][data-k="auth"]', 'ALL');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'shot-03-vessel-register.png'), fullPage: true });

  log('\n=== 5. FORM EDITING (create + edit) ===');
  await page.click('[data-act="vessel-form"]');
  await page.waitForTimeout(400);
  check('vessel form modal opened', await page.locator('#modalOverlay .modal').count() === 1);
  // submit empty to force validation
  await page.click('#fSave');
  await page.waitForTimeout(250);
  const vErr = await page.locator('#formErr .err').count();
  check('validation blocks empty form', vErr === 1);
  const badFields = await page.locator('#modalOverlay .input.bad').count();
  check('invalid fields highlighted', badFields >= 3, String(badFields));
  await page.screenshot({ path: path.join(OUT, 'shot-04-vessel-form.png') });

  await page.fill('#fName', 'Test Cutter');
  await page.fill('#fReg', 'TN-07-TST-9999');
  await page.fill('#fOwner', 'Verification Cell');
  await page.selectOption('#fType', 'Patrol');
  await page.selectOption('#fAuth', 'AUTHORIZED');
  await page.fill('#fLng', '77.5510');
  await page.fill('#fLat', '8.0700');
  await page.fill('#fSpd', '11.5');
  await page.fill('#fDir', '90');
  await page.click('#fSave');
  await page.waitForTimeout(500);
  const afterCreate = await page.evaluate(() => ({
    n: S.vessels.length, last: S.vessels[S.vessels.length - 1].vesselId,
    name: S.vessels[S.vessels.length - 1].name,
    audit: S.audit[0].action
  }));
  check('new vessel persisted to store', afterCreate.n === 15 && afterCreate.name === 'Test Cutter', JSON.stringify(afterCreate));
  check('create written to audit trail', afterCreate.audit === 'CREATE', afterCreate.audit);
  check('modal closed after save', await page.locator('#modalOverlay').count() === 0);

  // edit it back
  await page.click(`[data-act="vessel-form"][data-id="${afterCreate.last}"]`);
  await page.waitForTimeout(400);
  await page.fill('#fName', 'Test Cutter II');
  await page.selectOption('#fAuth', 'UNAUTHORIZED');
  await page.click('#fSave');
  await page.waitForTimeout(400);
  const afterEdit = await page.evaluate(() => {
    const v = S.vessels.find(x => x.name === 'Test Cutter II');
    return { found: !!v, auth: v && v.authorizationStatus, audit: S.audit[0].action };
  });
  check('edit persisted', afterEdit.found && afterEdit.auth === 'UNAUTHORIZED', JSON.stringify(afterEdit));
  check('update written to audit trail', afterEdit.audit === 'UPDATE', afterEdit.audit);

  log('\n=== 6. ZONE EDITOR (geofence CRUD + validation) ===');
  await page.click('.sidebar [data-route="zones"]');
  await page.waitForTimeout(500);
  const zoneCards = await page.locator('.grid .card').count();
  check('zone cards rendered', zoneCards >= 6, String(zoneCards));
  await page.click('[data-act="zone-new"]');
  await page.waitForTimeout(500);
  check('zone modal opened', await page.locator('#modalOverlay .modal').count() === 1);
  check('polygon vertex rows present', await page.locator('#vlist [data-vrow]').count() === 4);
  check('live preview rendered', await page.locator('#zonePreview svg').count() === 1);
  await page.screenshot({ path: path.join(OUT, 'shot-05-zone-editor.png') });
  await page.click('#zSave');
  await page.waitForTimeout(300);
  check('zone name validation fires', await page.locator('#formErr .err').count() === 1);
  await page.fill('#zName', 'Verification Box');
  await page.fill('#zBuf', '1500');
  await page.click('[data-act="zone-vadd"]');
  await page.waitForTimeout(200);
  check('vertex added', await page.locator('#vlist [data-vrow]').count() === 5);
  await page.click('#zSave');
  await page.waitForTimeout(500);
  const zoneRes = await page.evaluate(() => {
    const z = S.zones[S.zones.length - 1];
    return { n: S.zones.length, id: z.zoneId, ring: z.geometry.coordinates[0].length, closed: JSON.stringify(z.geometry.coordinates[0][0]) === JSON.stringify(z.geometry.coordinates[0][z.geometry.coordinates[0].length - 1]) };
  });
  check('zone persisted', zoneRes.n === 7 && zoneRes.id === 'Z007', JSON.stringify(zoneRes));
  check('polygon ring auto-closed', zoneRes.closed && zoneRes.ring === 6, JSON.stringify(zoneRes));
  await page.screenshot({ path: path.join(OUT, 'shot-06-zone-register.png'), fullPage: true });

  log('\n=== 7. LIVE MONITORING + SIMULATION ENGINE ===');
  await page.click('.sidebar [data-route="monitoring"]');
  await page.waitForTimeout(1500);
  const mapInfo = await page.evaluate(() => ({
    leaflet: !!(window.L && MAP.inst),
    mode: MAP.mode,
    markers: Object.keys(MAP.mk).length,
    zones: Object.keys(MAP.zoneL).length,
    trails: Object.keys(MAP.trail).length,
    scenarios: document.querySelectorAll('.scen').length,
    hasMapEl: !!document.getElementById('map')
  }));
  log('  map: ' + JSON.stringify(mapInfo));
  check('all 5 scenarios listed', mapInfo.scenarios === 5, String(mapInfo.scenarios));
  check('vessel markers on map', mapInfo.markers >= 15, String(mapInfo.markers));
  check('zone overlays on map', mapInfo.zones === 7, String(mapInfo.zones));
  check('breadcrumb trails drawn', mapInfo.trails >= 15, String(mapInfo.trails));
  await page.screenshot({ path: path.join(OUT, 'shot-07-monitoring-live.png') });

  log('\n--- map survives navigation away and back (regression guard) ---');
  const beforeNav = await page.evaluate(() => ({ inst: !!MAP.inst, tiles: document.querySelectorAll('.leaflet-tile').length }));
  await page.evaluate(() => go('dashboard'));
  await page.waitForTimeout(500);
  await page.evaluate(() => go('monitoring'));
  await page.waitForTimeout(1200);
  const afterNav = await page.evaluate(() => {
    const shell = document.querySelector('.map-shell');
    const host = document.getElementById('map');
    return {
      inst: !!MAP.inst,
      sameInstance: MAP.inst === MAP._ref,
      hostInShell: !!(shell && host && host.parentNode === shell),
      tiles: document.querySelectorAll('.leaflet-tile').length,
      loaded: Array.from(document.querySelectorAll('.leaflet-tile')).filter(i => i.complete && i.naturalWidth > 0).length
    };
  });
  check('map instance preserved across navigation', beforeNav.inst && afterNav.inst && afterNav.hostInShell,
    JSON.stringify({ beforeNav, afterNav }));
  check('basemap tiles still rendered after round trip',
    afterNav.tiles > 0 && afterNav.loaded > 0, JSON.stringify(afterNav));

  log('\n--- arming Intrusion Demo at 5x ---');
  // Subscribe to the real event bus so the status ladder is observed
  // deterministically rather than by sampling the DOM.
  await page.evaluate(() => {
    window.__trace = [];
    bus.on('approach', p => { if (p.vessel.vesselId === 'V002') window.__trace.push('APPROACHING'); });
    bus.on('intrusion', p => { if (p.vessel.vesselId === 'V002') window.__trace.push('INTRUSION:' + p.zone.zoneId); });
  });
  await page.click('[data-act="scenario"][data-key="intrusion"]');
  await page.waitForTimeout(400);
  await page.click('[data-act="speed"][data-v="5"]');
  await page.waitForTimeout(300);
  await page.click('[data-act="sim-start"]');
  await page.waitForTimeout(300);
  check('engine running', await page.evaluate(() => S.sim.running === true));

  let popupSeen = false, t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const st = await page.evaluate(() => ({
      trace: window.__trace.slice(),
      status: (S.vessels.find(x => x.vesselId === 'V002') || {}).status,
      pop: !!document.getElementById('alertPop'),
      elapsed: S.sim.elapsed
    }));
    if (st.status === 'INTRUSION' && st.pop) { popupSeen = true; break; }
    await page.waitForTimeout(200);
  }
  const trace = await page.evaluate(() => window.__trace.slice());
  log('  observed ladder: ' + JSON.stringify(trace));
  check('V002 reached APPROACHING (Haversine buffer, layer 1)', trace.indexOf('APPROACHING') >= 0, JSON.stringify(trace));
  check('APPROACHING preceded INTRUSION', trace.indexOf('APPROACHING') >= 0 &&
    trace.findIndex(t => t.startsWith('INTRUSION')) > trace.indexOf('APPROACHING'), JSON.stringify(trace));
  check('V002 reached INTRUSION in Z001 (ray-casting containment, layer 2)',
    trace.indexOf('INTRUSION:Z001') >= 0, JSON.stringify(trace));
  check('critical pop-up modal triggered', popupSeen);
  if (popupSeen) await page.screenshot({ path: path.join(OUT, 'shot-08-intrusion-popup.png') });
  await page.evaluate(() => closeAlertPop());

  const pipeline = await page.evaluate(() => {
    const a = S.alerts.find(x => x.vesselId === 'V002' && x.zoneId === 'Z001' && x.status !== 'CLEARED');
    const i = S.incidents.find(x => x.vesselId === 'V002');
    return {
      alertId: a && a.alertId, alertStatus: a && a.status, severity: a && a.severity,
      incId: i && i.incidentId, incStatus: i && i.status, timeline: i && i.timeline.length,
      feedTop: S.feed[0] && S.feed[0].title,
      streamTop: S.stream[0] && S.stream[0].msg,
      audioPref: S.prefs.audio
    };
  });
  log('  pipeline: ' + JSON.stringify(pipeline));
  check('alert record created at CRITICAL severity', !!pipeline.alertId && pipeline.severity === 'CRITICAL', JSON.stringify(pipeline));
  check('incident record auto-created', !!pipeline.incId, pipeline.incId);
  check('incident timeline seeded', pipeline.timeline >= 5, String(pipeline.timeline));
  check('event stream logged the breach', /INTRUSION/.test(pipeline.streamTop || ''), pipeline.streamTop);

  log('\n--- alert register ---');
  // Freeze the picture: a live engine can raise a second intrusion (legitimate
  // exit-and-re-entry) mid-assertion and arm a new modal.
  await haltEngine(page);
  await dismissAlerts(page);
  await page.click('.sidebar [data-route="alerts"]');
  await page.waitForTimeout(600);
  const alertRows = await page.locator('table.tbl tbody tr').count();
  check('alert register lists the generated alert', alertRows > 0, String(alertRows));
  await page.screenshot({ path: path.join(OUT, 'shot-09-alert-register.png'), fullPage: true });

  log('\n=== 8. ALERT DEDUPLICATION ===');
  const dedup = await page.evaluate(async () => {
    const before = S.alerts.filter(a => a.vesselId === 'V002').length;
    // force repeated boundary-cross evaluations on the same vessel/zone pair
    const v = S.vessels.find(x => x.vesselId === 'V002');
    v._prev = {};
    for (let k = 0; k < 6; k++) { v._prev = {}; evaluateVessel(v); }
    const after = S.alerts.filter(a => a.vesselId === 'V002').length;
    const live = S.alerts.filter(a => a.vesselId === 'V002' && (a.status === 'ACTIVE' || a.status === 'ACKNOWLEDGED')).length;
    return { before, after, live };
  });
  check('no duplicate alerts for the same vessel/zone pair', dedup.after === dedup.before, JSON.stringify(dedup));

  log('\n=== 9. INCIDENT WORKFLOW ===');
  await page.evaluate(() => { if (S.sim.timer) clearInterval(S.sim.timer); S.sim.running = false; });
  const incId = pipeline.incId;
  await page.click('.sidebar [data-route="incidents"]');
  await page.waitForTimeout(500);
  check('incident table rendered', await page.locator('table.tbl tbody tr').count() > 0);
  await page.click(`[data-act="inc-view"][data-id="${incId}"]`);
  await page.waitForTimeout(500);
  check('incident drawer opened', await page.locator('#drawer').count() === 1);
  check('timeline rendered in drawer', await page.locator('#drawer .tl-item').count() >= 5);
  await page.screenshot({ path: path.join(OUT, 'shot-10-incident-drawer.png') });

  const flow = [];
  for (const [act, want] of [['inc-ack', 'ACKNOWLEDGED'], ['inc-investigate', 'INVESTIGATING'], ['inc-resolve', 'RESOLVED'], ['inc-close', 'CLOSED']]) {
    await dismissAlerts(page);
    await page.click('.sidebar [data-route="incidents"]');
    await page.waitForTimeout(350);
    await page.click(`[data-act="inc-view"][data-id="${incId}"]`);
    await page.waitForTimeout(350);
    const btn = page.locator(`#drawer [data-act="${act}"]`);
    if (await btn.count() === 0) { flow.push(act + ':button-missing'); continue; }
    await btn.first().click();
    await page.waitForTimeout(400);
    const st = await page.evaluate(id => (S.incidents.find(x => x.incidentId === id) || {}).status, incId);
    flow.push(act + ':' + st + (st === want ? ' OK' : ' EXPECTED ' + want));
  }
  log('  workflow: ' + flow.join(' | '));
  check('incident lifecycle OPEN->ACK->INVESTIGATING->RESOLVED->CLOSED',
    flow.every(f => f.endsWith('OK')), flow.join(' | '));

  log('\n=== 10. FORENSICS / PLAYBACK ===');
  await page.click('.sidebar [data-route="history"]');
  await page.waitForTimeout(700);
  const hist = await page.evaluate(() => ({
    fixes: document.getElementById('playRange') ? document.getElementById('playRange').max : null,
    plot: !!document.querySelector('#playPlot svg'),
    tableRows: document.querySelectorAll('table.tbl tbody tr').length
  }));
  check('playback slider bound to fix count', +hist.fixes > 20, JSON.stringify(hist));
  check('trajectory plot rendered', hist.plot);
  await page.fill('#playRange', '5');
  await page.dispatchEvent('#playRange', 'input');
  await page.waitForTimeout(300);
  const info = await page.locator('#playInfo').textContent();
  check('playback scrub updates readout', /FIX 6 \//.test(info || ''), info);
  await page.screenshot({ path: path.join(OUT, 'shot-11-history-playback.png'), fullPage: true });

  log('\n--- vessel dossier (captured with a populated track) ---');
  await page.evaluate(() => go('vessel', { id: 'V002' }));
  await page.waitForTimeout(800);
  const dossier = await page.evaluate(() => ({
    route: S.route,
    h1: (document.querySelector('#view h1') || {}).textContent,
    bigSvg: Array.from(document.querySelectorAll('#view svg'))
      .filter(s => s.clientWidth > 120).length,
    fixes: (S.locations['V002'] || []).length,
    emptyStates: Array.from(document.querySelectorAll('#view .empty')).map(e => (e.textContent || '').trim())
  }));
  log('  dossier: ' + JSON.stringify(dossier));
  check('dossier route resolves for a vessel id', dossier.route === 'vessel' && /Dossier/.test(dossier.h1 || ''), JSON.stringify(dossier));
  check('dossier plots the retained track', dossier.bigSvg >= 1 && dossier.fixes > 0, JSON.stringify(dossier));
  check('dossier Geofence Contact panel is populated, not an empty state',
    dossier.emptyStates.length === 0, JSON.stringify(dossier.emptyStates));
  await page.screenshot({ path: path.join(OUT, 'shot-12-vessel-dossier.png'), fullPage: true });

  log('\n=== 11. ANALYTICS ===');
  await page.click('.sidebar [data-route="analytics"]');
  await page.waitForTimeout(600);
  const an = await page.evaluate(() => ({
    charts: document.querySelectorAll('svg.chart').length,
    donuts: document.querySelectorAll('.donut-c svg').length,
    tiles: document.querySelectorAll('.tile').length,
    hbars: document.querySelectorAll('.hbar').length
  }));
  log('  analytics: ' + JSON.stringify(an));
  check('analytics line/bar charts rendered', an.charts >= 2, JSON.stringify(an));
  check('analytics donuts rendered', an.donuts >= 1, JSON.stringify(an));
  check('analytics KPI tiles rendered', an.tiles >= 6, JSON.stringify(an));
  await page.screenshot({ path: path.join(OUT, 'shot-13-analytics.png'), fullPage: true });

  log('\n=== 12. RBAC — operator role must not see administration ===');
  check('operator cannot see accounts module', await page.locator('.sidebar [data-route="users"]').count() === 0);
  check('operator cannot see audit module', await page.locator('.sidebar [data-route="audit"]').count() === 0);
  await page.click('.sidebar [data-route="settings"]');
  await page.waitForTimeout(500);
  check('settings toggles rendered', await page.locator('[data-pref]').count() >= 4);
  const guard = await page.evaluate(() => { go('users'); return S.route; });
  check('deep-link to admin route is refused for operator', guard !== 'users', guard);

  log('\n=== 12b. ADMIN ROLE ===');
  await page.evaluate(() => signOut());
  await page.waitForTimeout(400);
  check('sign-out returns to login screen', await page.locator('#login .login-card').count() === 1);
  await page.click('[data-demo="admin@cidrtm.navy.in|admin123"]');
  await page.click('#loginForm button[type=submit]');
  await page.waitForTimeout(800);
  check('admin sees accounts module', await page.locator('.sidebar [data-route="users"]').count() === 1);
  check('admin sees audit module', await page.locator('.sidebar [data-route="audit"]').count() === 1);

  await page.click('.sidebar [data-route="users"]');
  await page.waitForTimeout(500);
  check('operator accounts listed', await page.locator('table.tbl tbody tr').count() === 5,
    String(await page.locator('table.tbl tbody tr').count()));
  // account creation form
  await page.click('[data-act="user-form"]');
  await page.waitForTimeout(400);
  await page.fill('#uName', 'Lt. Verification');
  await page.fill('#uMail', 'not-an-email');
  await page.fill('#uPass', 'short');
  await page.click('#uSave');
  await page.waitForTimeout(300);
  check('account form rejects invalid email and short password',
    await page.locator('#formErr .err').count() === 1);
  await page.fill('#uMail', 'verify@cidrtm.navy.in');
  await page.fill('#uPass', 'verifypass123');
  await page.selectOption('#uRole', 'COMMANDER');
  await page.click('#uSave');
  await page.waitForTimeout(500);
  const newUser = await page.evaluate(() => {
    const u = S.users.find(x => x.email === 'verify@cidrtm.navy.in');
    return { created: !!u, role: u && u.role, audit: S.audit[0].action };
  });
  check('account created with assigned role', newUser.created && newUser.role === 'COMMANDER', JSON.stringify(newUser));
  check('account creation audited', newUser.audit === 'CREATE', newUser.audit);

  await page.click('.sidebar [data-route="audit"]');
  await page.waitForTimeout(500);
  const auditRows = await page.locator('table.tbl tbody tr').count();
  check('audit trail populated', auditRows > 0, String(auditRows));
  const audited = await page.evaluate(() => S.audit.some(a => a.cat === 'SECURITY' && a.action === 'INTRUSION'));
  check('intrusion recorded in audit trail', audited);
  await page.screenshot({ path: path.join(OUT, 'shot-14-audit-trail.png'), fullPage: true });

  log('\n=== 13. RESPONSIVE LAYOUT ===');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => go('vessels'));
  await page.waitForTimeout(700);
  const mobile = await page.evaluate(() => ({
    hamburgerVisible: getComputedStyle(document.querySelector('.hamb')).display !== 'none',
    sidebarOffCanvas: document.querySelector('.sidebar').getBoundingClientRect().right <= 1,
    tableHidden: getComputedStyle(document.querySelector('.tbl-wrap')).display === 'none',
    cardsVisible: getComputedStyle(document.querySelector('.mcards')).display !== 'none',
    cardCount: document.querySelectorAll('.mcard').length,
    noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
    docWidth: document.documentElement.scrollWidth,
    winWidth: window.innerWidth
  }));
  log('  mobile: ' + JSON.stringify(mobile));
  check('hamburger appears on mobile', mobile.hamburgerVisible);
  check('sidebar moves off-canvas', mobile.sidebarOffCanvas);
  check('table swaps to card list', mobile.tableHidden && mobile.cardsVisible);
  check('mobile cards rendered', mobile.cardCount > 0, String(mobile.cardCount));
  check('no horizontal overflow on mobile', mobile.noHScroll, `${mobile.docWidth} > ${mobile.winWidth}`);
  // hamburger must actually open the drawer
  await page.click('.hamb');
  await page.waitForTimeout(400);
  const drawerOpen = await page.evaluate(() => document.querySelector('.sidebar').classList.contains('open'));
  check('hamburger opens the navigation drawer', drawerOpen);
  await page.screenshot({ path: path.join(OUT, 'shot-15-responsive-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 834, height: 1112 });
  await page.evaluate(() => go('dashboard'));
  await page.waitForTimeout(700);
  const tab = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow on tablet', tab);
  await page.screenshot({ path: path.join(OUT, 'shot-16-responsive-tablet.png'), fullPage: true });

  log('\n=== 14. RUNTIME ERRORS ===');
  const realErrors = consoleErrors.filter(e => !/favicon|tile|net::ERR|Failed to load resource|cartocdn|unpkg|openstreetmap/i.test(e));
  log('  console errors (raw ' + consoleErrors.length + '):');
  consoleErrors.slice(0, 12).forEach(e => log('    - ' + e.slice(0, 170)));
  log('  page errors: ' + pageErrors.length);
  pageErrors.slice(0, 8).forEach(e => log('    ! ' + e.slice(0, 300)));
  check('no uncaught page exceptions', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));
  check('no application console errors', realErrors.length === 0, realErrors.join(' | ').slice(0, 300));

  log('\n=== RESULT ===');
  log(fails.length === 0 ? 'ALL CHECKS PASSED' : (fails.length + ' CHECK(S) FAILED: ' + fails.join('; ')));
  await browser.close();
  process.exit(fails.length === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
