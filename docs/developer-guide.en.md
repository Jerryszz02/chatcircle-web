# Chat Circles Developer Guide

[中文](developer-guide.md) | English

For developers and agents taking over this repository for the first time. Start the local environment using this guide, then consult the [documentation index](README.md) for the area you are changing. See [business-rules.md](business-rules.md) for business rules and [maintenance.md](maintenance.md) for outstanding maintenance gaps. The current code, migrations, and tests are the source of truth for the implementation; maintain documentation changes in the same PR as the related code. Linked specialist documentation may be in Chinese.

## 1. Project at a glance

**Chat Circles** is a **multi-organization platform for activity management, registration review, check-in, surveys, and listener training**, operated centrally by Empact. It brings registration, check-in, and surveys for nonprofit mental health support activities out of WeChat groups and scattered spreadsheets and into one website. The production domain is `chatcircle.empact.cn`.

The core business workflow (the complete lifecycle of a piece of data):

```
Organization creates activity (publish/approve) → Participant registers → Organization reviews manually → On-site check-in by scanning a fixed QR code → Post-activity survey → Organization/platform dashboard and exports → External agent produces and uploads a report
```

Three user roles (distinguish these from roles within an activity):

| Role | Backend identity | Data scope |
|---|---|---|
| Super administrator | PocketBase `_superusers` | Entire platform |
| Organization administrator | `admin_accounts` (auth collection with `organization_id`) | Own organization only |
| Participant | `participant_accounts` (auth collection, not tied to an organization; username/phone number + password is the primary sign-in identity in T2, with phone verification-code sign-in as an alternative) | Own records only |

Speaker/listener **are not platform roles**. They are the `activity_role` on each registration record; the same participant can choose different roles for different activities. Listener training is an independent system, separate from activities: check-in eligibility means the account has an approved listener registration for any activity across the platform.

The technology in one sentence: **React 18 + Vite + TypeScript as a single SPA (mobile-first, with `/`, `/admin`, and `/super` areas by role) + PocketBase 0.39.7 (authentication / API rules / pb_hooks business rules / SQLite) + a four-service Docker Compose deployment (PocketBase serves the functional SPA from `pb_public/` on the same origin, while a separate public-web service renders public pages with SSR)**.

## 2. Repository map

```
├── frontend/            # React SPA: src/features/{participant,admin,superadmin} + src/shared/
│                        #   See the frontend sections; operational detail is in this guide's §6
│                        #   Also src/public/ + server/ (public-page SSR, see §6.8), output dist-public/
├── backend/             # PocketBase backend
│   ├── pb_migrations/   #   Versioned schema, indexes, and access rules; the only entry point for schema changes
│   ├── pb_hooks/        #   Server business rules (JSVM *.pb.js): custom routes + Realtime guards + write guards + audit
│   ├── tests/           #   L3 integration suite + migration smoke (required in CI); bash/curl/python3 standard library only
│   ├── scripts/         #   Seed data and historical data backfills
│   ├── pb_data/         #   Local development data (SQLite), NOT committed
│   ├── pb_public/       #   Frontend build output, served on the same origin by PocketBase, NOT committed
│   └── pocketbase       #   Binary must be downloaded manually, NOT committed
├── mcp/                 # MCP server for data-analysis agents (export API for data; reports collection for uploads)
├── e2e/                 # Playwright end-to-end tests for the main workflows (L4)
├── deploy/              # backup.sh daily backups, Caddy proxy config, public-web image and smoke, production deployment manual
├── docs/
│   ├── developer-guide.md      # Chinese source of this guide: current code and guidance for changes
│   ├── README.md               # Handoff reading order and specialist documentation index
│   └── maintenance.md          # Outstanding maintenance work and acceptance boundaries
├── .github/workflows/   # ci.yml (required for PRs) / deploy.yml (automatic deployment on main pushes) / e2e.yml
├── Dockerfile           # Multi-stage: frontend build → PocketBase runtime (combined image)
├── docker-compose.yml   # Four services: app + public-web + backup + caddy
└── .env.example         # All environment variables (real .env and secrets are NOT committed)
```

## 3. Local development environment

Prerequisites: Node.js 22, npm, Python 3, curl/unzip, and PocketBase **0.39.7**, matching `.env.example` / CI. See [backend/README.md](../backend/README.md) for download and directory arguments. Do not treat an old local binary or production data as a fresh environment.

Start each block below from the repository root. These commands use local test configuration; the mock verification code is for development only:

```sh
# Terminal 1: backend
cd backend
export CC_ENVIRONMENT=development
export CC_SMS_PROVIDER=mock
export CC_SMS_MOCK_CODE=246810
export CC_PHONE_HASH_KEY=local-development-only-phone-hash-key
./pocketbase migrate up --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
# On first use, create a local super administrator as described in backend/README.md
./pocketbase serve --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
```

```sh
# Terminal 2: frontend; /api is proxied to 127.0.0.1:8090
npm ci --prefix frontend
npm run dev --prefix frontend
```

Backend health check: `http://127.0.0.1:8090/api/cc/health`; development administration console: `http://127.0.0.1:8090/_/`. Use the frontend address printed by Vite.

See the backend manual for optional demo data. The seed script starts a temporary instance itself, so stop any service using the same database first. If a super administrator already exists, supply the local account through `SEED_SU_EMAIL` / `SEED_SU_PASS`; do not mix it with the script's default password. Everyday development does not require production SMS or SMTP credentials.

For public-page SSR, run `npm run build:public --prefix frontend` and `npm run start:public --prefix frontend` separately (default port 3100, with local port 8090 as the default upstream). See [public-web.md](public-web.md). The Vite development server covers only the SPA.

Production Compose requires `CC_PHONE_HASH_KEY` and `CC_BACKUP_KEY`; backup no longer uses super administrator credentials. Production SMS also requires Alibaba Cloud scenario templates and RAM credentials. See the [deployment manual](../deploy/README.md) for complete configuration and starting all four services. For everyday local development, prefer the native setup above. Base Compose does not expose host port 8090; explicitly add `deploy/docker-compose.debug.yml` only for debugging, and do not use this debug override in production.

Common port conventions: development backend 8090 / temporary seed instance 8096 / integration tests 8097 / migration smoke 8099 / e2e 18090+14173.

## 4. Architecture overview: five models to understand first

1. **Writes are centralized.** Almost all business writes (registration, review, check-in, surveys, exports, invitation codes, and more) go through custom endpoints in `pb_hooks` (`POST /api/cc/*`) and complete within server-side transactions. Guards such as `guards.pb.js` block direct collection create/update operations, and direct delete is disabled for every collection. The frontend mainly uses collection APIs for **reads**.
2. **There are two read paths.** Administration interfaces read collections through native PocketBase APIs + API rules (organization isolation uses chained relation lookups based on `@request.auth.organization_id`). Participants read public/aggregated information through allowlisted hooks endpoints (`/api/cc/public/*`, `/api/cc/me/*`), rather than directly accessing collections.
3. **Organization isolation is enforced server-side.** There are two write paths: in **custom endpoints**, hooks always inject `organization_id` from the signed-in identity and ignore any client-supplied value. For the few permitted **direct collection create** operations (activities, training, organization-specific registration fields), the frontend explicitly supplies its own `organization_id` from the signed-in administrator's identity (for example, `ActivityForm.tsx`). API rules validate `@request.auth.organization_id = organization_id`, and guards prevent changing it in subsequent updates. Rules filter reads by identity. Cross-organization access returns **404 rather than 403**, avoiding disclosure that a resource exists.
4. **No hard deletion.** Business collections disable delete for ordinary users. Disabling, archiving, voiding, revoking, and releasing are represented with status fields (FR-AUD-001). Do not introduce hard deletion for everyday operations. Follow the [privacy operations manual](privacy-operations.md) when handling legally required personal-information deletion requests.
5. **pb_hooks uses isolated JavaScript scopes; it is not a Node project.** Each `*.pb.js` file in PocketBase JSVM has a completely isolated scope, with no imports or shared globals. Files such as http/ratelimit/audit under `pb_hooks/lib/` are **the canonical contract sources and are not loaded at runtime**. Each domain file **inlines exact copies** of the helper functions it needs inside its own closure. **After changing lib semantics, synchronize every inline copy.** This is the repository's biggest maintenance trap; file headers warn against manually editing the copies.

Overall request path in production: browser → Caddy (TLS, security headers, blocks `/_/*`, routes by path) → public routes go to public-web:3100 (SSR), while `/api/*` and the functional SPA go to PocketBase (`pb_public/` static frontend + collection APIs + `/api/cc/*` hooks) → SQLite. PocketBase is also public-web's only upstream, through anonymous public endpoints.

## 5. Backend in detail

### 5.1 Data model overview

All schema definitions are in `backend/pb_migrations/`. Each migration file creates one domain (named `<Unix时间戳>_cc_<域名>.js`, using a Unix timestamp and domain name, and executed in timestamp order). Grouped by domain:

**Accounts and organizations**

| Collection | Purpose and key fields |
|---|---|
| `organizations` | Organization master data + organization-level settings: `status` (active/disabled), `require_activity_approval` (platform review required for activity publication), `allow_sensitive_export` (sensitive-export setting). |
| `admin_accounts` (auth) | Organization administrators: username + password, `organization_id`, `status`; `authRule: status='active'` prevents disabled accounts from signing in; tokens last 7 days. |
| `admin_invites` | One-time administrator invitation codes: **only `token_hash` is stored** (sha256); plain text is returned only once at generation; `status` (unused/used/revoked/expired), `expires_at` (7 days by default). |
| `participant_accounts` (auth) | Participants: from T2 onward, username/phone number + password is the primary sign-in identity, with phone verification-code sign-in as an alternative; full `phone_e164` and the HMAC lookup value are hidden, and public responses expose only the masked number / binding status; tokens last 30 days. |
| `participant_phone_challenges` | Internal phone verification-code challenges: store only the phone-number HMAC, purpose, account relation, provider/status/expiry; no full phone number or verification code; all collection API rules are closed. |

**Activities and registrations**

| Collection | Purpose and key fields |
|---|---|
| `activities` | Activities: alongside lifecycle, capacity, registration, and check-in tokens, T2 adds `pairing_started_at/by`, `onsite_locked_at/by`, and next on-site sequence counters for both roles; internal on-site fields can be changed only by server-side transactions. |
| `activity_approvals` | Immutable, append-only publication review history: `action` (submit/approve/reject), `reason` (required for rejection). |
| `registration_field_defs` | Registration field definitions: `organization_id=''` means a platform-standard field (maintained only by super administrators); a nonempty value means an organization-specific field. `field_code`, `field_type` (text/number/single_choice/multi_choice/date), `is_sensitive` (**the sole basis for export filtering**), `role_scope` (both/speaker/listener, for role-specific registration forms); composite unique key (organization_id, field_code). |
| `registrations` | Registrations: `activity_role` (speaker/listener), `status` (4 states); composite unique key (activity_id, participant_id) = one registration per person per activity; **no redundant organization_id**, with isolation through `activity_id.organization_id`. |
| `registration_answers` | Registration answers in `value_json`, read-only after writing; composite unique key (registration_id, field_def_id). |

**Check-in**

| Collection | Purpose and key fields |
|---|---|
| `checkin_sessions` | Check-in windows: no row is created for “not yet open”; each opening creates a new row, and closing sets it to `closed`. Hooks transactions ensure at most one `open` row at a time (currently maintained at the application layer). |
| `checkins` | Check-in records: revocation retains the original row. In T2, the same transaction that creates a valid check-in writes `onsite_role/onsite_sequence/numbered_at` and increments the activity's role counter. Numbers are not reused after revocation; existing check-ins are not backfilled with numbers. |
| `activity_pairs` | T2 pairing records: monotonically increasing `pair_sequence` within each activity, both sides' registration/check-in references, `active/released/completed` states, and adjustment/release history. Participants cannot read this collection directly; all writes go through pairing hooks. |

**Surveys**

| Collection | Purpose and key fields |
|---|---|
| `survey_templates` + `survey_template_versions` | Standard templates + immutable version snapshots. The two collections **reference each other** (`current_version_id ↔ template_id`), so migrations create them in three steps. After publication, version update/delete are disabled. A template upgrade means adding a version and moving the current pointer; `schema_json` stores complete question definitions. |
| `activity_surveys` | Activity surveys: created as **materialized copies** of template versions and do not follow later template upgrades; unique `survey_code`/`qr_token`, `role_scope`, `status` (5 states). |
| `survey_questions` | Survey questions (schema_json materialized as rows): `question_code` (stable machine code), `question_type` (7 types: info/single_choice/multi_choice/scale_1_5/scale_0_10/text_short/text_long), `locked` (organizations cannot change or delete locked core questions), `is_sensitive`; composite unique key (activity_survey_id, question_code). |
| `submissions` | Survey submissions: one per person per survey (draft → submitted is a **status change on the same row**); `status` (draft/submitted/voided); composite unique key (activity_survey_id, participant_id). Completion counts use submitted records; **all exports and statistics exclude voided records**. |
| `answers` | Question answers: `question_code` is **stored redundantly** (exports can join directly, and historical answers are unaffected by question changes); composite unique key (submission_id, question_code). |

**Exports / audit / reports**

| Collection | Purpose and key fields |
|---|---|
| `export_jobs` | Export jobs: `organization_id=''` means a platform-wide export by a super administrator; `scope_json`, `include_pii` (sensitive-export flag, requiring organization permission + second confirmation + audit), `file_path` (protected directory), `status` (running/done/failed). |
| `audit_logs` | Immutable audit records: only server-side `writeAudit()` writes them; update/delete are disabled. `actor_id` (`'system'` for system jobs), `actor_role`, `action` (such as `registration.approve`, `backup.failed`), `result`, `metadata` (**must not contain passwords or complete sensitive answers**). |
| `reports` | Data-analysis reports (uploaded by external agents through MCP): `file` is protected (the URL must include a token), `status` (draft/published; agent uploads are forced to draft); all rules null = super administrators only. |

**Listener training** (2026-08 extension, separate from activities and mirroring the three check-in collections)

| Collection | Purpose |
|---|---|
| `trainings` / `training_checkin_sessions` / `training_attendances` | Training master data / check-in windows / attendance records, structured like activity check-in; `trainings.status` has only 3 states. At account level, “training completed” means at least one valid attendances record exists. |

### 5.2 API rules permission model

- `_superusers` inherently bypass all rules. Platform-level collections (organizations, admin_invites, survey_templates/versions, reports) have all rules set to `null` = super administrators only.
- Organization administrators are consistently scoped by `@request.auth.organization_id = <本行机构>` (the organization on this row), using chained relations for nested child records (for example, `answers` uses the three-level `submission_id.activity_survey_id.activity_id.organization_id`).
- For permitted direct create operations (activities, trainings, the organization-specific part of registration_field_defs), the client supplies `organization_id`, and createRule validates `@request.auth.organization_id = organization_id`. Therefore, similar new direct-creation flows **must supply their own organization's value**; omitting it fails validation and is rejected.
- For every collection where `organization_id` can be empty, start the rule with `@request.auth.organization_id != ''` to prevent participants/anonymous requests from matching `''=''` and reading platform-level records.
- Participants can list/view only their own records. Create is usually locked or limited to their own account with a fixed initial status; records cannot be changed after submission.
- An unauthenticated list request against a collection with a nonempty rule returns **an empty set** rather than 403 (only a null rule yields 401/403). Distinguish these cases when troubleshooting permissions.

### 5.3 Complete state machines

**Activity `activities.status` (7 states):** `draft → published → closed → archived`; when the organization requires publication review, `draft → pending_review → published` (super administrator approve/reject; rejected activities can be edited and resubmitted); `published → taken_down` (super administrators only). Registration review is rejected for activities already taken_down/archived.

**Registration `registrations.status` (4 states, no waitlist):** Transitions use `POST /api/cc/registrations/{id}/transition`, with an allowlisted matrix (`CC_REGISTRATION_TRANSITIONS` in `registrations.pb.js`; anything outside the matrix returns `ILLEGAL_TRANSITION`):

| Transition | Action code | Notes |
|---|---|---|
| pending→approved | `registration.approve` | Capacity is strictly checked within the transaction. |
| pending→rejected | `registration.reject` | |
| approved→cancelled | `registration.cancel` | reason is required. |
| rejected/cancelled→approved | `registration.status_revert` | reason is required; capacity is checked again. |

Requests to the same state return idempotently. Approval may also change `activity_role`, with a separate `registration.role_change` audit entry.

**Check-in:** `checkins.status` = valid/revoked; prerequisites = approved registration and an open session. Distinguish `checkin_not_open` (never opened) from `checkin_closed` (opened, then closed).

**Activity survey `activity_surveys.status` (5 states):** `draft/not_open → open → ended` (+archived); administrators manually open and end responses. Participant eligibility has **four conditions**: signed in + approved registration + role matches role_scope + survey open (check-in is explicitly not required).

**Survey submission `submissions.status` (3 states):** draft→submitted changes the same row; submission locks the record, and submit is idempotent. Voiding permits only submitted→voided (administrator, reason required, audited); V1 does not support resubmission after voiding.

**Training `trainings.status` (3 states):** draft→published→closed; training check-in eligibility = any approved listener registration across the platform (otherwise `listener_not_approved`).

### 5.4 API and code entry points

See `frontend/src/shared/api/accountEvent.ts` for machine request/response types and the [API contracts](api-contracts.md) for key permission, idempotency, real-time, and export semantics. Read each file's `routerAdd` declarations for complete routes rather than maintaining a second endpoint catalog that can drift.

| Domain | Entry points in `backend/pb_hooks/` |
| --- | --- |
| Account passwords, invitation codes, SMS, administrator email | `auth.pb.js`, `authguard.pb.js`, `phoneauth.pb.js`, `mailguard.pb.js` |
| Activities, registrations, check-in, on-site pairing, snapshots | `activities.pb.js`, `registrations.pb.js`, `checkins.pb.js`, `pairings.pb.js`, `live.pb.js` |
| Surveys, submissions, training | `surveys.pb.js`, `submissions.pb.js`, `trainings.pb.js` |
| Dashboards, exports, reports, posts | `metrics.pb.js`, `exports.pb.js`, `exports_v2.pb.js`, `reports.pb.js`, `posts.pb.js` |
| Super administration, write guards, name/template constraints | `super.pb.js`, `guards.pb.js`, `release.pb.js` |
| Internal backups, public health check | `backup.pb.js`, `main.pb.js` |

```sh
rg -n 'routerAdd' backend/pb_hooks
```

### 5.5 Cross-cutting mechanisms

- **Audit:** `writeAudit(app, entry)` is expected to run **in the same transaction as the business write** (pass txApp within a transaction). Action codes are defined across the domain files; update audit coverage when changing business actions.
- **Rate limiting:** Some windows use `$app.store()`; some authentication/export quotas are persisted through database transactions. Read `authguard.pb.js`, `phoneauth.pb.js`, and the export implementation separately; do not assume every rate limit clears on restart. In production behind Caddy, trusted proxy headers must be enabled (migration `1785889200` already sets `X-Forwarded-For`), or per-IP rate limiting becomes a shared platform-wide bucket.
- **Sensitive-export filtering:** Ordinary exports exclude data based on the two flags `registration_field_defs.is_sensitive` and `survey_questions.is_sensitive` (**field-name heuristics are prohibited**); participants.csv does not contain username. Sensitive exports require an organization setting + second confirmation with `confirm:true` + a separate audit action. CSV formula injection protection prefixes a single quote for `= + - @ Tab`. Export files are stored in `pb_data/exports` (0700/0600), with random filenames and path-prefix protection on downloads.
- **Concurrent capacity checks:** The registration creation endpoint performs only a preliminary check. **The strict check happens within the transition-to-approved transaction**, checking total and role capacity. SQLite busy errors are retried 2 times before returning 409.
- **Error shape:** Uniform `{code, message, data:{code}}`. Handlers throw `ccError`, which a top-level catch converts; throwing within a transaction rolls it back. Some files (surveys/submissions/exports/super/metrics) also use direct `jsonError` returns. Follow the style already used in the file you are editing.
- **Realtime only invalidates data:** After subscribing to activities/registrations/checkins/activity_surveys/submissions/activity_pairs, the administration interface debounces and refetches `live-summary`; it does not derive metrics from event payloads. Participants can subscribe only to their own `cc.participant.pairing.<participantId>` topic, and messages are sanitized again against the current authentication before sending. If any demographic bucket is smaller than 5, all buckets in that dimension are suppressed together, preventing inference by subtraction from the total approved count.
- **Configuration:** Hooks read environment variables such as the phone HMAC key, SMS provider, and backup key through `$os.getenv()`. See `.env.example` and Compose's environment pass-through configuration for the list. New configuration must update the example, runtime validation, and release gates; do not print values.

### 5.6 Migration conventions

- Use `migrate((app) => {up}, (app) => {down})` and document what down can reverse (the smoke script checks the up→down→up round trip). Migrations that preserve business data do not guarantee restoration of old business behavior. Schema down is not equivalent to a production rollback.
- Follow the repository's migration convention: explicitly declare two autodate fields for every collection.
- Set `bool` to `required: false` (to avoid required bool forcing a true value).
- Empty relations store `''`, not NULL (“platform-level vs organization-level” uses `organization_id = ''`; empty strings can participate in unique indexes).
- Set every relation to `cascadeDelete: false`, consistent with no hard deletion.
- Conditional uniqueness, such as the currently open session, is enforced by hooks transactions. Check migrations and concurrency tests before adding constraints; do not use an unconditional unique index that breaks historical records.
- A failed `migrate` can still exit with code 0. Scripts must grep output for `Error` (the test scripts already do this).

### 5.7 Backend testing

The [backend testing manual](../backend/tests/README.md) covers isolated databases, fixtures, ports, and upgrade tests. Any new endpoint that can be associated with `organization_id` must add unauthorized-access cases in the same PR. Avoid unnecessary built-in `auth-with-password` calls that exhaust the IP rate-limit budget; use the fixture's impersonate factory. Preserve the runner's ordering constraints for rate-limit suites.

## 6. Frontend in detail (`frontend/`)

### 6.1 Technology choices

Minimal dependencies: react/react-dom 18, react-router-dom 7, pocketbase SDK 0.21 (both HTTP client and auth storage), and qrcode (generates QR-code dataURLs locally in administration interfaces). **No** state library, UI library, CSS framework, or chart library (dashboards use numeric cards only). State management = useState/useEffect + PB authStore subscriptions. Build script: `build = tsc --noEmit && vite build` (type-check first).

### 6.2 Structure and layers

```
src/
├── router.tsx             # The application's sole route table (+ router.test.tsx guard tests)
├── shared/                # Shared layer across all three interfaces
│   ├── pocketbase.ts      #   3 role-isolated PB client singletons (see §6.3)
│   ├── auth.ts / session.ts / guards.tsx
│   ├── api/               #   types.ts (current record types + enums, manually synced with pb_migrations)
│   │                      #   accountEvent.ts (T0 frozen contract; T1–T6 implemented)
│   │                      #   collections.ts (typed RecordService wrapper), http.ts (custom-endpoint fetch wrapper)
│   ├── ui/                #   Unstyled structural components (Button/Card/Modal/Toast/Loading/PageLayout/ForbiddenPage…)
│   ├── styles/global.css  #   Design tokens + shared .cc-* classes (see §6.6)
│   ├── metrics/           #   Dashboard metric registry (matches backend metrics.pb.js)
│   ├── survey/            #   Survey-question editor draft model (shared by admin/superadmin)
│   └── lib/datetime.ts    #   PB UTC date parsing and local-day→UTC boundary conversion
├── features/{participant,admin,superadmin}/
│   ├── pages.tsx          #   Barrel, also imports the interface's CSS
│   ├── pages/  components/  lib/   # Pages / interface-specific components / pure domain functions (tests focus on lib)
│   └── api.ts(or lib/api.ts)       # Custom-endpoint wrappers; admin/lib/activityLive.ts handles T3 Realtime invalidation subscriptions and refetching,
│                                   #   participant/lib/myPairingLive.ts handles T5 invalidation subscriptions and refetching of the participant's own pairing status
└── test/                  # vitest setup + mockApi.ts (fetch stub utilities)
```

### 6.3 Authentication model and route guards

- **One PB client singleton per role**, with tokens stored under separate localStorage keys (`cc_participant_auth`/`cc_admin_auth`/`cc_super_auth`). Successful sign-in for any role **clears the other two role sessions** (mutually exclusive single session). Role→collection mapping: participant→participant_accounts, admin→admin_accounts, super→_superusers.
- PB address: `VITE_PB_URL`, falling back to `window.location.origin` (same origin in production). AutoCancellation is disabled. The client has two wrappers: stripUndefinedParams (SDK 0.21 serializes `filter: undefined` as a string, causing 400) + uniform administration-side 401 handling that clears the session and redirects to sign-in (participants are not redirected here; pages handle return navigation through `?redirect=` themselves).
- Sign-in/registration paths: Participants sign in with username/phone number + password or register with username + password + phone number at `/login` and in the registration workflow. Phone verification-code sign-in is an alternative for existing accounts only. Organization administrators use `authWithPassword` + the invitation-code registration endpoint. Super administrators have no registration page.
- Route guard `RequireRole` (`shared/guards.tsx`): valid session for this role→allow; session for another role→403 page; not signed in→corresponding sign-in page. **Guards are only UX; server-side rules/hooks always enforce permissions.** Do not change only the frontend when changing permissions.
- Reactive sessions: `useSessionSnapshot()` subscribes to all three authStores using useSyncExternalStore.

### 6.4 Data fetching and error handling conventions

There is no request library. Two patterns are used: collection data calls the SDK directly through `collectionsForRole(role).xxx.getList(...)`; business actions use each feature's api module and `apiGet/apiPost` from `shared/api/http.ts` (errors are normalized into `ApiError{status, code, details}`, with business error codes read from `details.code`). Pages hand-write `useState(data/error/loading) + useEffect(cancelled flag) + useCallback(reload)`. Export downloads are an exception: native fetch + Authorization + blob. In T3, `features/admin/lib/activityLive.ts` establishes Realtime subscriptions before fetching the initial snapshot; events trigger only debounced refetching, and disconnect/reconnect updates connection status and refreshes the snapshot. In T5, `features/participant/lib/myPairingLive.ts` + `lib/useMyPairing.ts` apply the same pattern to the participant's own pairing status (subscribe to their own `checkins` + `cc.participant.pairing.<participantId>` topic, then refetch `my-pairing`; subscription failure falls back to a one-time snapshot + offline message; background refresh failure retains the old snapshot and marks it stale through error). The check-in success and activity detail pages use the single-activity container `components/MyPairingCard.tsx` (text + status icon + color together convey the state). The “My” area uses page-level `useMyPairingMap` with one subscription for multiple activities + the presentational `MyPairingCardView`; pairing cards mount only for approved registrations.

### 6.5 Route list

| Area | Routes |
|---|---|
| Participant `/` (public pages do not require sign-in) | `/` landing page (latest 2 current activities and latest 2 public posts about past activities), `/activities` current activities (only those not ended), `/activities/past` all public posts, `/a/:activityId` detail, `/a/:activityId/register` registration, `/login`; session required: `/me` My area, `/checkin/:token` QR check-in, `/survey/:qrToken` survey responses, `/trainings`, `/training-checkin/:token`. |
| Organization `/admin` | Public: `/admin/login`, `/admin/email-login`, `/admin/verify-email`, `/admin/reset-password`, `/admin/register` (invitation code + username + email + password); guarded: `/admin/activities` (+`/new` T4 step-by-step creation wizard, `/:activityId` lifecycle panel + five-tab detail including the on-site workspace), `/admin/trainings` (+`/:id`), `/admin/dashboard`, `/admin/exports`, `/admin/audit`. |
| Super administrator `/super` | Public: `/super/login`; guarded: `/super/organizations` (organizations + invitation codes + settings), `/super/approvals`, `/super/activities`, `/super/posts` (content posts), `/super/dashboard`, `/super/exports`, `/super/audit`, `/super/system` (backup warnings + template management). |

### 6.6 Styling

Hand-written CSS only. `shared/styles/global.css` provides `:root` design tokens (`--cc-brand/neutral/success/...` colors, rounded corners, shadows, animation; **components do not hardcode hex colors**) and shared `.cc-*` classes. The three area style files—`participant.css` (`.ccp-*`), `admin.css` (`.admin-*`), and `superadmin.css` (`.sa-*`)—are imported by each interface's barrel and loaded only for that interface. The public area also includes homepage style overrides. Use the existing CSS and rendered pages as the reference; see [business rules](business-rules.md) for mobile usability requirements.

### 6.7 Frontend tests

Vitest + jsdom + Testing Library; tests are colocated with source files and focus on **pure lib functions** (state machines, copy, form validation) and page behavior (`stubApi()` in `src/test/mockApi.ts` stubs fetch by “METHOD path fragment”; `makeTestToken/saveParticipantSession` injects signed-in state). `router.test.tsx` uses MemoryRouter to verify guards for all three areas. Run `npm test`.

### 6.8 Public-page SSR / GEO

Public pages (`/`, `/about`, `/privacy`, `/activities`, `/activities/past`, `/a/:id`, `/posts/:id`) use server-side rendering in the separate `public-web` service, so search engines and fetchers without JavaScript can read the body and metadata directly. Functional pages (business interfaces after sign-in) remain in the original SPA. See [public-web.md](public-web.md) for design decisions and rejected approaches.

```text
Browser/crawler
  ▼
Caddy (exact routing by path; see the header comments in deploy/Caddyfile)
  ├─ Public pages + /public-assets/* + /robots.txt + /sitemap.xml + unknown paths → public-web:3100 (SSR)
  │     │ Anonymous public endpoints only (/api/cc/public/*, posts collection)
  │     ▼
  └─ /api/* + /assets/* + functional SPA (/login /me /admin/* /super/* /a/:id/register …) → app:8090
                                  ↑ Also the upstream for public-web
```

- **Public data-layer allowlist:** `src/public/data.ts` calls only anonymously readable public endpoints. Every response is narrowed through allowlist mappers to DTOs in `src/public/types.ts`. Fields such as `registration_fields`, `created_by/updated_by`, and phone numbers are always removed and must not enter public HTML. Adding a public-page field means adding a DTO field, then a mapper; **never pass upstream JSON through directly**. Draft/taken-down/hidden content returns a generic 404 page without revealing that it exists.
- **Code locations:** `src/public/` (routes, metadata, data layer, views; rendering shares components with the SPA), `server/` (node:http service, no framework or runtime dependencies); build output: `dist-public/{client,server}`.
- **Commands:** `npm run build:public` (client + server bundles), `npm run start:public` (start the renderer locally, default 3100), `npm run test:public` (vitest subset for `src/public` + `server`). See `server/config.ts` for configuration (`PORT` / `CC_SITE_ORIGIN` / `CC_PB_INTERNAL_URL` / `CC_PUBLIC_FETCH_TIMEOUT_MS` / `CC_PUBLIC_MAX_INFLIGHT`; none are secrets).
- **Routing boundary:** A Caddy path matcher without a wildcard matches exactly. `/a/:id/register` (functional page) must match before `/a/*` (public detail). Unknown paths always receive a real 404 from the renderer, rather than a misleading SPA 200. **Synchronize three places when adding public/functional routes:** `src/public/routes.ts`, `src/router.tsx`, `deploy/Caddyfile` (`deploy/verify-release-config.mjs` statically checks the Caddy side).
- **Metadata:** `src/public/metadata.ts` generates each page's `title/description/canonical/og:*`. Initial data is embedded in `<script type="application/json" id="__CC_PUBLIC_DATA__">` (not executable; CSP does not need to allow inline scripts), then reused during client hydration. The renderer serves `robots.txt` (Disallow for functional paths + site-wide GPTBot opt-out + Sitemap line). Functional SPA paths also receive the server-side Caddy header `X-Robots-Tag: noindex`. `sitemap.xml` lists only URLs currently returning 200; an upstream failure returns 503, never an empty sitemap pretending to succeed.
- **Verify readability without JavaScript:**

```sh
npm run build:public && npm run start:public   # Also requires local PocketBase on 8090
curl -s http://127.0.0.1:3100/ | grep -o 'rel="canonical"'        # SSR metadata
curl -s http://127.0.0.1:3100/ | grep -c '__CC_PUBLIC_DATA__'     # Initial data marker
curl -s http://127.0.0.1:3100/robots.txt                          # Disallow and Sitemap lines
```

The same applies in production (`https://chatcircle.empact.cn/`). The deployment gate automates these three assertions.

## 7. End-to-end business workflows (frontend and backend together)

**Main participant workflow:** Directory/detail (`GET /api/cc/public/activities*`) → sign-in/registration (username/phone number + password, or phone verification code; new users must register with username + password + phone number at `/login` or in the registration workflow; first-time verification no longer creates an account automatically) → submit registration (`POST .../register`, rendering fields for the selected role's role_scope) → view review status and bind/change phone number under `/me` (`GET /api/cc/me/overview`) → scan the fixed QR code at the venue → `POST /api/cc/checkin/self` (idempotent) → post-activity survey draft/submission.

**Organization administrator's everyday workflow:** Create activity (draft) → submit for approval if the organization requires review → publish → review registrations (transition, with strict capacity checks in a transaction) → open check-in, pairing, and surveys in the on-site workspace → use the five-step wizard to generate XLSX or CSV ZIP by scope/data domain/rows/columns → training follows a similar workflow. The old v1 fixed set of 13 CSV files is still used by MCP; do not remove it solely because an old plan described a transition period.

**Super administrator:** Create organizations, generate one-time invitation codes (plain text displayed once only), configure organization settings (publication review/sensitive exports), approve/take down activities, manage content posts (`/super/posts`, pinning/visibility, no hard deletion), manage survey template versions, view global dashboards/exports/audit, and check backup warnings (`/super/system`).

**Data outlet:** Export ZIP → external analysis agent retrieves data through the MCP server in `mcp/` (`export_activity_data` always uses `include_pii:false` and returns only a file path, not the contents) → `upload_report` uploads the report to the `reports` collection (forced to draft; a human reviews and publishes it; hooks record `report.upload` in the audit log).

MCP is a STDIO process launched by local clients such as WorkBuddy, Kimi, Claude, or Codex. The Chat Circles backend URL
is only the PocketBase address it accesses, not a remote MCP endpoint. See [`mcp/README.md`](../mcp/README.md) for complete client configurations, first sign-in and acceptance checks, and cloud-agent limitations.

## 8. Common change recipes

**Add a collection / field**

1. Create `backend/pb_migrations/<新时间戳>_cc_<域名>.js` (using a new timestamp and domain name; follow §5.6: explicit created/updated, bool not required, cascadeDelete false, deleteRule null, appropriate API rules).
2. Synchronize `frontend/src/shared/api/types.ts` (types + enums) and `collections.ts`.
3. Run `bash backend/tests/migration_smoke.sh` (up/down round trip) and the integration suite.
4. If the collection has `organization_id`, **add unauthorized-access cases to `suite_acl.py` in the same PR** (required).

**Add a business endpoint (write operation)**

1. For phone numbers/on-site pairing/activity snapshots/fine-grained exports, first check the [API contracts](api-contracts.md) and `shared/api/accountEvent.ts`. Do not change machine names or redefine equivalent types within a feature. T3 snapshots must also preserve the boundary that Realtime only invalidates and the server recomputes.
2. Add `routerAdd` in the appropriate domain's `pb_hooks/*.pb.js`. Use that file's inline helpers such as `requireAuth`/`ccError`/`writeAudit`. For organization resources, always inject organization_id server-side and return 404 for cross-organization access. Perform writes inside a transaction and record audit entries.
3. Update `guards.pb.js` when direct writes need to be blocked.
4. Integration tests: add assertions to the corresponding suite; new organization resources must add `suite_acl.py` cases in the same PR. Mind the auth budget (§5.7).
5. Frontend: add a wrapper in the relevant feature's `api.ts`, import shared request/response types directly, and update the contract comments in the file header.

**Change registration fields:** Fields are **data, not code**. Super administrators maintain platform-standard fields in `registration_field_defs` (`organization_id=''`); organizations add their own custom fields. `role_scope` controls role-specific display/validation, and `is_sensitive` controls export filtering. Frontend role-specific rendering is in `features/participant/lib/registrationForm.ts`.

**Add a dashboard metric:** Add a key to the registry in backend `metrics.pb.js` (document the metric definition in the header comments) + a definition in frontend `shared/metrics/registry.ts`. Administration dashboards render from the registry, so the pages do not need changes.

**Change UI:** For tokens, edit `global.css`. Follow the `.cc-/.ccp-/.admin-/.sa-` prefix conventions for component styling. Do not initiate business-rule changes from the UI layer.

**Upgrade PocketBase:** Synchronize four places: `PB_VERSION` in `.env.example`, `ARG PB_VERSION` + `PB_SHA256` in `Dockerfile`, `.github/workflows/ci.yml` and `e2e.yml`, and constants in backend test scripts.

**Change contract helpers in `pb_hooks/lib/`:** Synchronize every inline copy in domain files afterward (grep the function name to find all copies). This is the biggest trap described in §4 and bears repeating.

## 9. Tests and CI

Run the smallest meaningful checks for the area changed, then use the [release checklist](release-checklist.md) for acceptance before release. Do not hardcode total test counts in documentation; use the output from the current run.

| Change scope | Run from the repository root |
| --- | --- |
| Frontend | `npm run lint --prefix frontend`, `npm run typecheck --prefix frontend`, `npm test --prefix frontend`, `npm run build --prefix frontend` |
| Public SSR | `npm run test:public --prefix frontend`, `npm run build:public --prefix frontend` |
| Backend business logic/permissions | `bash backend/tests/run_integration.sh` |
| Data migrations | `bash backend/tests/migration_smoke.sh`; also run `pocketbase_upgrade.sh` for PB version upgrades; see the backend testing manual. |
| End-to-end | `npm test --prefix e2e`; see the [E2E manual](../e2e/README.md) for first-time setup. |
| MCP | `npm ci --prefix mcp`, `npm test --prefix mcp` |
| Deployment configuration/backups | `node deploy/verify-release-config.mjs`, `node --test deploy/*.test.mjs backend/tests/*.test.mjs`, `python3 -m unittest discover -s deploy -p 'test_*.py'`; for image changes, also run the corresponding Docker smoke. |
| Documentation | Check relative links/anchors and commands against current configuration; `git diff --check`. |

See `.github/workflows/ci.yml` for the actual CI jobs (frontend, migrations/deployment configuration, backend integration, dependency audit, MCP installation, backup/public-web Docker smoke). E2E runs separately in `e2e.yml`. `scripts/t7-release-acceptance.sh` provides a single entry point for some checks and requires installed dependencies and OSV-Scanner; it does not replace all CI jobs.

## 10. Deployment and operations entry points

The [deployment manual](../deploy/README.md) covers configuration, pinned-SHA releases, the four-service topology, and troubleshooting. The [backup and recovery manual](../deploy/backup-recovery.md) covers consistent copies, isolated recovery, and alerts. Do not run tests locally against a real production database.

Deploy accepts only successful main-push CI for the same full SHA. It first builds and preflights, performs a consistent backup using the old runtime, and prepares volume permissions; only then does it fast-forward the production directory and switch images. It subsequently checks revision, health, and public pages. It neither waits automatically for separate E2E nor rolls back automatically. An old SHA usually fails the fast-forward requirement; replaying it directly is not a rollback. Incident recovery must align the code, database, HMAC key, and gateway configuration.

By default, only the latest 2 successful backups are retained locally. The scheduler runs daily at 02:00 Beijing time, and backups may also be generated before and after deployments. The count is a number of backups, not days. Offsite backup is deferred until a destination is chosen; then use [offsite-backup.md](../deploy/offsite-backup.md) for configuration and actual recovery acceptance.

## 11. Essential boundaries (read before changing code)

1. Schema changes must go through `pb_migrations/`; do not edit production schema manually through the admin UI.
2. Business rules belong only in `pb_hooks/` and API rules. Frontend validation is an experience layer.
3. No hard deletion: use status for disabling/archiving/voiding/revoking, and do not enable delete for any collection.
4. Enforce organization isolation server-side: inject organization_id in custom endpoints; permitted direct create operations supply the organization's own value from the client and validate it through API rules. Cross-organization access returns 404. New endpoints with organization_id must add unauthorized-access tests in the same PR.
5. Sensitive-data export filtering uses only `is_sensitive` flags; field-name heuristics are prohibited.
6. Audit and business writes share a transaction. Metadata must not contain passwords or complete sensitive answers.
7. Hooks use JSVM and `$os.getenv()`. Changes to `lib/` contracts must synchronize all inline copies.
8. Integration tests must avoid exhausting the built-in authentication rate-limit budget. New suites must preserve the runner's isolation and execution-order constraints.
9. Realtime payloads do not carry authoritative metrics. Events only invalidate snapshots; final values must be reread from the server's aggregation within the same snapshot.
10. Use environment variables for environment differences: commit `.env.example`, but not the real `.env` or secrets.
11. See [business-rules.md](business-rules.md) for business definitions. Confirm requirements before changing an approved rule, then update contracts and tests in the same PR.

---

*Maintain this guide alongside the code. If you change a mechanism covered here (repository structure, endpoint lists, state machines, conventions), update this guide in the same PR.*
