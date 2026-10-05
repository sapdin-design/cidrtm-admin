# CIDRTM — Coastal Security Monitoring Console

Operator console for the **Coastal Intrusion Detection & Real-Time Naval Security
Monitoring System**. This is the CSOC (Coastal Security Operations Centre) admin
dashboard: login, operations dashboard, list management, and full record editing,
with a tactical dark HUD, a live GIS picture, and a working geofence engine.

**Region:** Kanyakumari Coast, Tamil Nadu — 8.0883° N, 77.5385° E
**Telemetry source:** software GNSS simulation engine. No hardware required.

---

## Running it

```
git clone https://github.com/sapdin-design/cidrtm-admin.git
cd cidrtm-admin
```

Then open `index.html` in any modern browser. That is the whole deployment.

```
start index.html          # Windows
open  index.html          # macOS
xdg-open index.html       # Linux
```

There is no build step, no `npm install`, no bundler and no server. Everything —
design system, chart renderer, geofence engine, simulation engine, routing — lives
in one self-contained file. Only the basemap tiles and the Leaflet library are
fetched from the network, and the console degrades gracefully without them.

Because it runs from `file://`, you can also just download `index.html` on its own
and double-click it. Nothing else is required.

### Demonstration credentials

| Role | Service email | Passphrase | Sees |
|---|---|---|---|
| Watch Operator | `operator@cidrtm.navy.in` | `security123` | Operations + Intelligence |
| Commander | `commander@cidrtm.navy.in` | `command123` | Everything |
| Administrator | `admin@cidrtm.navy.in` | `admin123` | Everything |

The login screen has one-click buttons for each. Sessions are held in
`sessionStorage` and survive a page reload for 8 hours.

---

## The five-minute viva walkthrough

1. **Log in** as the Watch Operator.
2. **Operations Dashboard** — note the seeded operational backlog: 14 tracked hulls,
   1 active alert, 1 open incident, 5 active geofences. Twelve hours of trend data
   and the alert severity mix are already populated.
3. **Live Security Monitoring** — open the map. Vessel markers rotate to heading,
   dashed rings show each zone's Haversine warning buffer, and breadcrumb trails
   show the last 20 fixes per hull.
4. In the **Simulator Control Centre**, select scenario **2 — Intrusion Demo**.
   Set the clock to **5x** and press **START**.
5. Watch vessel **V002 Ocean Runner** (orange, unauthorised) run in on Z001:
   - status `NORMAL` → `APPROACHING` (amber) when it crosses the 1,000 m buffer
   - status `APPROACHING` → `INTRUSION` (crimson, pulsing) on polygon entry
   - a **critical pop-up**, an audible siren, an alert and an incident are raised
6. **Alert Register** — the new alert is `ACTIVE`. Press **Acknowledge**.
7. **Incident Register** — open the incident. The timeline shows the full chain:
   approach logged → boundary crossed → intrusion detected → alert raised →
   incident opened. Advance it `ACKNOWLEDGED → INVESTIGATING → RESOLVED → CLOSED`,
   appending an investigation note.
8. **Vessel History & Playback** — scrub the track slider to replay the approach
   fix by fix, with speed-over-ground and status at each point.
9. **Analytics** — detection trend, diurnal profile, zone breach distribution,
   repeat offenders and the response-time ledger.
10. **Sign out** and back in as Administrator to see the **Operator Accounts** and
    **Audit Trail** modules that are hidden from the operator role.

Scenario **5 — Full Security Demonstration** runs the entire six-stage pipeline
unattended; it is designed to be watched at 5x–10x.

---

## Geofencing engine

Every position fix is evaluated against every active zone through a **dual-layer**
test, exactly as specified:

**Layer 1 — Haversine range check.** Great-circle distance from the vessel to the
zone centroid. Within `warningDistance` (but outside the polygon) → `APPROACHING`.

**Layer 2 — ray-casting containment.** Even-odd point-in-polygon test against the
polygon ring. Inside + `AUTHORIZED` → `AUTHORIZED`. Inside + `UNAUTHORIZED` →
`INTRUSION`.

Status precedence is `INTRUSION > APPROACHING > AUTHORIZED > NORMAL`, so a hull in
a restricted polygon is never masked by a milder state in a neighbouring zone.

### Alert deduplication

Before an intrusion is recorded, the engine searches for an existing alert for the
same `(vesselId, zoneId)` pair in `ACTIVE` or `ACKNOWLEDGED` state:

- **Found** → suppress the re-trigger, refresh position and range only.
- **Not found** → run the trigger sequence: create the alert, create the incident
  with a seeded timeline, increment metrics, and emit `intrusion:detected`.

A vessel that leaves the polygon clears its alert, so a genuine re-entry does
raise a fresh alert. Approaches are throttled by a configurable dedup window
(default 30 s, editable under Settings).

> **Geometry note.** Each zone polygon is deliberately compact relative to its
> warning buffer. If a buffer were smaller than the polygon's inradius the
> centroid test would sit entirely inside the polygon and the `APPROACHING` layer
> could never fire. `vesselsInsideAnyZone()` and the buffer/inradius check in the
> verification harness guard both invariants.

---

## Module map

| Module | Route | Purpose |
|---|---|---|
| Operations Dashboard | `dashboard` | KPIs, 12 h trend, severity mix, priority contacts, activity feed |
| Live Security Monitoring | `monitoring` | Leaflet GIS picture, simulator HUD, telemetry, event stream |
| Vessel Register | `vessels` | Search / filter / sort / paginate; create, edit, delete, track |
| Vessel Dossier | `vessel` | Identity, telemetry, trajectory plot, zone contact, incident history |
| Geofence Zones | `zones` | Zone cards, polygon vertex editor with live preview, activate/deactivate |
| Alert Register | `alerts` | Severity/status filters, acknowledge, resolve, geospatial detail |
| Incident Register | `incidents` | Lifecycle workflow, timeline, investigation notes, assignment |
| Vessel History | `history` | Track reconstruction with breadcrumb playback and CSV export |
| Analytics | `analytics` | Detection/response analytics, MTTR, P90 response, distributions |
| Operator Accounts | `users` | Role-based accounts, create/edit/suspend (ADMIN, COMMANDER) |
| Audit Trail | `audit` | Immutable action log with category filter and purge |
| System Settings | `settings` | Alerting, engine, theatre defaults, state export, factory reset |

Role gating is enforced in `canSee()` for the navigation and re-checked in `go()`,
so a deep link to an administration route is refused for an operator.

---

## Responsive behaviour

| Width | Behaviour |
|---|---|
| ≥ 1600 px | KPI counters inline in the command bar; region and health chips visible |
| 1024–1599 px | KPIs move to a dedicated horizontally-scrollable status rail |
| ≤ 1024 px | Sidebar becomes an off-canvas drawer behind a hamburger |
| ≤ 760 px | Data tables swap to a stacked card list; health chip hidden |
| ≤ 560 px | Brand text hidden, leaving the shield mark |

The status rail scrolls horizontally rather than widening the document, so no
route produces horizontal overflow at any width — asserted at 390 px and 834 px.

---

## Verification

Behaviour is verified in headless Chromium, not by inspection. To reproduce:

```
# Playwright is the harness's only dependency. Installing it creates a
# package.json and node_modules/ here; neither is part of this project.
npm install --save-dev playwright
npx playwright install chromium
node verify.js
```

Requires Node 18 or newer. The harness drives the real `index.html` over
`file://`, so no server needs to be running and nothing needs to be built.

86 assertions across 14 groups: authentication (including a rejected passphrase),
seed integrity, dashboard KPIs, list search/filter/sort, form create/edit with
validation, zone polygon editing, the map round trip, the full
`NORMAL → APPROACHING → INTRUSION` ladder observed on the real event bus, alert
deduplication, the incident lifecycle, playback, the vessel dossier, analytics,
RBAC, responsive layout, and zero uncaught exceptions.

The harness subscribes to the application's own event bus rather than sampling the
DOM, so the status-ladder assertion is deterministic rather than timing-dependent.

Two seed-integrity invariants are asserted explicitly, because both were violated
in early drafts and neither is visible from a passing syntax check:

- **No vessel may be seeded inside a live polygon.** Otherwise the console reports
  intrusions the instant the engine starts and the status ladder is never reached.
- **Every warning buffer must extend beyond its own polygon's inradius.** Measured
  as centroid-to-*edge*, not centroid-to-vertex — the latter is the circumradius and
  overstates a pentagon's interior by roughly 24%. If the buffer lies wholly inside
  the polygon, `APPROACHING` is unreachable by construction.

The same run also captures the 16 reference screenshots (`shot-01-…` to
`shot-16-…`), so the images in this directory always correspond to a green run.

---

## Scope and honest limitations

This is the **front-end operator console**, built as a single self-contained
artifact so it runs anywhere with no infrastructure. What that means:

- **State is in memory.** A page reload restores the seed data. There is no
  database, no persistence and no multi-user session sharing.
- **Authentication is simulated.** Passwords are compared in the browser and the
  JWT is a well-formed but unsigned token. It demonstrates role gating and the
  audit trail — it is not a security boundary.
- **Telemetry is simulated.** The GPS simulation engine drives all vessel motion.
  There is no real GNSS input.
- **Basemap tiles need network access.** If tiles fail, the console keeps drawing
  zone polygons, markers and trails on the dark grid; switch provider under
  Settings. All geospatial maths is local and works fully offline.

### Path to the full stack

The specification's MERN target (Express + Mongoose + Socket.IO + 2dsphere
indexes) is not part of this artifact. The console is written so that the swap is
mechanical:

- `S` is the single state container; every mutation goes through a small number of
  functions (`setIncidentStatus`, `acknowledgeAlert`, `vesselFormModal` save,
  `zoneFormModal` save, `userFormModal` save) — each is a natural API call site.
- The simulation engine emits `vessel:location_updated`, `zone:approach`,
  `intrusion:detected`, `alert:created` and `incident:created` on an internal bus
  (`bus.emit`). Repointing that bus at a `socket.io-client` instance is the whole
  real-time integration.
- The geofence algorithms (`isPointInPolygon`, `haversine`, `destination`,
  `polygonCentroid`, `distanceToPolygonEdge`) are dependency-free and drop straight
  into a backend `geofence.service.ts`.

---

## File tree

```
cidrtm-admin/
├── index.html        the entire console (design system, engine, views, routing)
├── verify.js         headless Chromium verification harness (86 assertions)
├── README.md
├── .gitignore
├── .gitattributes    forces LF endings; marks binaries
└── shot-*.png        16 reference screenshots captured from the verified build
```

The screenshots are generated by `verify.js` itself, so the images in this
directory always correspond to the last green run. Deleting them all and
re-running the harness regenerates the complete set.

---

## License

No license file is currently included, so by default **all rights are reserved** —
the code is public to read, but not licensed for reuse, modification or
redistribution. If you want to permit reuse, adding an MIT `LICENSE` file is the
usual choice for a project like this.
