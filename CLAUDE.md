# HantiOS Backend

HantiOS is an AI-powered SaaS ERP platform for African businesses (inventory, sales, debts, expenses, staff, multi-branch). This file is the persistent ground truth for the Lead Software Engineer identity working in this repo. A companion QA subagent lives at `.claude/agents/qa-tester.md` — invoke it after any feature or fix, before considering the work done.

## ⚡ Immediate next task

Staff Invitation (email-link, no OTP) is **done** — see "Staff Invitation" under Auth Architecture below for the spec it implements, and the API modules table for what's built vs. deferred. Next up, in order of what actually unblocks real usage:

1. **Signup + Login don't exist in this repo yet.** Everything built so far (including Staff Invitation's `authenticate` middleware) was tested by minting JWTs directly with `JWT_ACCESS_SECRET` — there is no real way for an owner to get a session today. This is the actual next task, not a roadmap nicety: without it, nothing built is reachable by a real user.
2. Staff module is incomplete: only `invite`/`accept-invite` exist. `list`/`role-change`/`deactivate`/`restore` are still unbuilt (deliberately deferred, see API modules table).
3. Resume the 15-session hardening roadmap at Session 7 (see below) once there's enough real functionality that hardening it is meaningful.

## Recovery context

This repo was rebuilt from total local loss (hardware failure destroyed all code + session history). The Neon Postgres database survived and is the source of truth for what's *actually* built — always run `npx prisma db pull` (`npm run prisma:pull`) and trust `prisma/schema.prisma` over the schema summary below if they ever disagree. This file is the source of truth for *why* things are the way they are and what's still missing.

## Tech stack

- Backend: Node.js + Express 5, TypeScript (strict)
- Database: PostgreSQL via Neon (serverless) + Prisma ORM 7, connected through `@prisma/adapter-neon` (Prisma 7 requires a driver adapter — plain connection strings in `schema.prisma` no longer work; the URL lives in `prisma.config.ts` for CLI/migrate use, and the adapter is passed directly to the `PrismaClient` constructor at runtime)
- Auth: JWT (access + refresh), Google OAuth (`google-auth-library`), bcryptjs for password hashing
- Validation: Zod (env validation belongs in `src/lib/config.ts`)
- Security middleware: Helmet, `cors` (env-driven allowlist via `CORS_ORIGINS`), `express-rate-limit`
- Testing: Jest + ts-jest + Supertest, run against the live Neon DB (no separate test DB exists — known risk; any test that creates data must clean up after itself, e.g. via a `cleanupTestBusiness` helper)

## Database schema (last known-correct — verify against `prisma/schema.prisma` after `db pull`)

**Foundation:** `Business` (plan/tier/country-derived currency & timezone, no Somalia hardcoding, `settings` JSONB catch-all), `User` (email is the primary login identifier, not phone; `passwordHash` nullable for Google accounts; `failedLoginAttempts` incremented atomically), `Branch`, `Warehouse` (exactly one per business, enforced via `@unique` on `businessId`).

**Core modules:** `Category`, `Product` (optimistic locking via `version`, packaging hierarchy each/inner_pack/box/carton/pallet), `BranchInventory` / `WarehouseStock` (quantity `CHECK >= 0`; **known limitation** — Postgres doesn't match `NULL=NULL` in unique indexes, so `@@unique([branchId, productId, size])` doesn't truly dedupe single-size products where `size` is `NULL`; worked around at the app layer with find-then-branch instead of upsert — a sentinel value instead of `NULL` is the proper fix, not yet done), `PriceHistory`, `PaymentMethod`, `Customer`, `Sale` (items JSON locks COGS at sale time; `total` allows negative only when `refundOfSaleId` is set), `Debt`, `Expense` (`branchId: null` means business-wide and must be set explicitly, never omitted).

**Auth / security / operational:** `Session` (refresh token hashed with SHA-256 not bcrypt — high-entropy token, not a low-entropy password; `rememberMe` drives cookie Max-Age 30d vs 12h, but `expiresAt` itself is always 7 days), `OtpChallenge` (purpose is `signup` or `password_reset` only — **never** `login`, **never** `staff_invite`), `LoginEvent`, `PasswordHistory` (last 3 checked to block reuse), `StaffInvite` (`token` unique, `email`/`full_name`/`phone`/`role` captured directly on the invite so it can exist before any account does; `user_id` is nullable — null until the invite is accepted and a real user gets created, then backfilled to link invite → resulting user; status is *not* a stored column, compute pending/accepted/expired/revoked from `accepted_at`/`revoked_at`/`expires_at` at the app layer, don't add a redundant status field), `InventoryAdjustment`, `AuditLog` (snapshots `userName`/`userRole` at write time, not live-joined; required `reason`; never updated or deleted — no update/delete code path should ever be written for this model), `IdempotencyKey`.

Full field-level detail lives in the recovery document and should match `prisma/schema.prisma` once pulled. **Never invent a field or model that isn't in one of those two places — ask if something seems missing.**

**Known schema gaps (logged, deliberately not fixed yet):**
- `Product` has no `version` column — the doc describes optimistic locking here, but it was never migrated. Don't assume Product writes are concurrency-safe until this is added.
- `DebtReminder` model doesn't exist in the live DB at all, despite being documented. If debt reminder scheduling work ever starts, this needs a migration first.
- `Expense` has no `deletedAt`/`deletedBy`/`restoreReason` (soft-delete fields the doc describes). Ties to hardening roadmap Session 11 ("soft-delete standards"), which is still not started.

(Fixed already, 2026-07-19: `staff_invites` got `token`/`email`/`full_name`/`phone`/`role` and `user_id` went nullable; `OtpPurpose.staff_invite` enum value was removed after confirming zero rows referenced it; `users.termsAcceptedAt`/`termsVersion`/`privacyAcceptedAt`/`privacyVersion` are now `NOT NULL` at the DB level, matching the "required" rule in Auth Architecture — this went one field further than literally requested, since leaving the two Version columns nullable while requiring the two AcceptedAt columns would've been an inconsistent half-fix.)

## Auth architecture (locked)

- **Signup:** Business Email + Password, or Google OAuth. Collects Business Name, Owner Name, Business Email, WhatsApp Phone, Password (email path only), Country (auto-fills currency/timezone/phone-prefix, all editable). WhatsApp OTP verifies phone once. Terms/Privacy acceptance required.
- **Login:** Email + Password (or Google). **No OTP on regular login, ever.**
- **Password policy:** min 8 chars, 1 upper, 1 lower, 1 number, 1 special char. Last 3 passwords blocked from reuse.
- **Email verification:** `emailVerifiedAt` gates password reset, security-alert emails, and staff-invite acceptance. Must be a real token sent to the invitee's own email — never a proxy check against the owner's email.
- **Staff Invitation (built, 2026-07-20 — `src/{services,controllers,routes}/staffInvite.*`):**
  1. Owner enters Full Name, Email, Phone, Role (`POST /staff/invite`, owner-only, `manager` deliberately excluded — confirm if that's wrong).
  2. System emails an Accept Invitation link: `${APP_BASE_URL}/invite/<token>`.
  3. Invitee clicks → `GET /staff/invite/:token` shows business name + role → sets a password + checks a Terms/Privacy consent box → `POST /staff/invite/:token/accept`.
  4. Account activates immediately, `email_verified_at` set at that moment (presenting the mailed token *is* the verification). **No OTP anywhere in this flow.**
  5. Same login rule applies afterward: email + password only — but there's no Login endpoint yet to actually use it (see "Immediate next task").
  - Invitable roles exclude `owner`/`super_admin` (enforced server-side via the Zod enum, not just UI). Invite token is 256-bit random, stored in `staff_invites.token` as plaintext (not hashed) — a deliberate choice matching the schema's own naming (contrast `sessions.refresh_token_hash`, which is hashed); revisit if that stops feeling right.
  - No resend/list/revoke-invite endpoints exist yet — a duplicate pending invite for the same business+email is a hard 409, not a resend.
  - QA caught and this fixed a real race: accepting the same invite token twice concurrently used to be able to 500 instead of cleanly 409 (the invite-claim wasn't atomic). Fixed by claiming the invite via `updateMany({ where: { id, accepted_at: null } })` and checking the row count *before* creating the user, inside the same transaction — not relying on an incidental `users.email` unique-constraint collision as the safety net. Regression test: `tests/staffInvite.accept.test.ts` ("only lets one of two concurrent accepts win").
  - Known minor gap, not fixed: `passwordSchema` (`src/lib/password.ts`) has no max length. Low risk (100kb body limit already bounds it), but worth a cap if this becomes a concern later.
- **New Device / High-Risk Login:** optional per-business toggle in `Business.settings` (`Settings → Security → Require OTP for New Devices`, default OFF). ON: unrecognized device triggers WhatsApp OTP. OFF (default): no OTP ever, on any device, for regular login.
- **Refresh tokens:** httpOnly cookie (never in the JSON body), double-submit CSRF cookie, rotated on every refresh.
- **RBAC:** `requireRole(...roles)` middleware. `super_admin` bypasses every check. `custom` role is fail-closed (403) until a permissions-evaluation engine exists — `User.permissions` JSON is present but unused, don't wire partial support for it.
- **Void vs Refund (Sales):** Void = same business day only, by the cashier who created it (owner/super_admin also pass; manager does **not** bypass). Refund = after day-close only, owner/manager only, financial-only — no inventory restore (that belongs to the not-yet-built Returns module).

## Notification routing (locked)

- `SECURITY` → Email (new login, password changed/reset, suspicious login, email/phone changed), falls back to WhatsApp only if email is unverified — never suppress a security alert silently.
- `BUSINESS_OPERATIONS` → WhatsApp (low stock, debt reminders).
- `MARKETING` → Email, and only for "new feature released" — trial/subscription triggers are blocked, there is no billing module.
- `SYSTEM_ALERTS` → Email + WhatsApp both, and only for DB-connection-lost / API-provider-failure — backup-failed/storage-full/license-expiring are blocked, the underlying features don't exist.
- `TRANSACTIONAL` → Email (staff account activated, anchored to accept-invite completion).

Implemented via a `NotificationProvider` interface; both WhatsApp and Email currently stub through `ConsoleNotificationProvider` — real Meta WhatsApp Business API is blocked on Business Verification, real email sending is still a stub.

## API modules

| Module | Endpoints | Status |
|---|---|---|
| Auth | signup, login, google/login, google/identify, forgot-password, reset-password (+verify-otp), refresh, logout, sessions (list/revoke), login-history | **Not built in this repo** — the doc's "Done" describes the lost codebase. Only the `authenticate`/`requireRole` middleware exists so far; nothing issues a real session yet |
| Staff | invite, accept-invite | **Done** (email-link, no OTP) |
| Staff | list, role-change, deactivate, restore | Not built yet |
| Customers | CRUD, archive | Not built in this repo (doc's "Done" is the lost codebase) |
| Products | CRUD, archive/restore, stock-adjustment (writes a real `InventoryAdjustment` row) | Not built in this repo |
| Branches, PaymentMethods | minimal CRUD | Not built in this repo |
| Sales | create, list, get, void, refund | Not built in this repo |
| Debts | create, list, get, payment, dispute | Not built in this repo |
| Expenses | CRUD, archive/restore | Not built in this repo |

All rows above marked "Not built in this repo" describe what existed in the lost codebase and are still architecturally correct targets (RBAC, transactions, audit, optimistic locking, etc. below still apply when they're built) — just don't assume any of their code exists yet. Staff Invitation is the only module with real, tested code in this repo so far.

Cross-cutting on all of the above: RBAC permission matrix (8 canonical roles), DB transactions on multi-table ops, `AuditLog` on 9 audited operations, optimistic locking (inventory adjustment / debt payment / sale refund), idempotency keys (void / refund / debt payment), DB `CHECK` constraints, pagination (`page/pageSize/sort/order/search`) on every list endpoint, `{data, pagination}` response envelope, cross-business 404 isolation via an `assertOwned()` helper, N+1 fix in `createSale`. Pattern is Controller → Service → Prisma, behind `authenticate` + `requireRole`.

## Hardening roadmap (resume at Session 7)

Sessions 1–6.5 done: Staff Invitation + password policy, auth hardening tests + CORS + security headers, Zod config validation + secrets fail-fast + payload limits, external integration adapters (Google/WhatsApp/Turnstile), security audit event logging, storage + feature-flag providers, notification architecture.

Not started: 7 (search stub + domain events + queue/scheduler scaffolding), 8 (API versioning `/api/v1/` + cursor pagination), 9 (distributed rate limiting + caching readiness + DB connection docs), 10 (process lifecycle + observability — graceful shutdown, `/health` vs `/ready`), 11 (soft-delete standards + Business Settings API), 12 (performance verification — `EXPLAIN ANALYZE`, load test), 13 (Docker, CI/CD, Dependabot), 14 (SLA/DR docs, OpenAPI), 15 (final production-readiness checklist).

## Not built yet (beyond the roadmap)

Receipts, Reports Center, Purchase Orders/Suppliers, Payroll, Cash Flow, Shareholders, Returns, Analytics Dashboard, AI Fraud Detection, Receipt Scanner, live Multi-Currency rates, the `custom`-role permission engine, Annual Close, Import/Export/Backup, Stock Count, Global Search (stub only), Activity Timeline UI, consolidated Business Settings API, Multi-Business Dashboard, Offline Mode, WhatsApp AI Agent, Mobile App, platform billing/subscription (absent entirely — this is why several Marketing/System-alert notification triggers above are blocked). The frontend is still separate HTML/React prototypes, not wired to this backend.

## Engineering standards

Write clean, modular, secure-by-default, tested, production-ready code. Follow SOLID, DRY, KISS, YAGNI. Don't design for hypothetical future requirements — this repo already has a 15-session roadmap of *known* future work; don't invent more.

**Security, always:** parameterized queries only (Prisma handles this — never drop to raw SQL with string interpolation), validate every input at the boundary (Zod), sanitize user data, never hardcode secrets, never log tokens/passwords/PII. Guard against SQL/NoSQL injection, XSS, CSRF, SSRF, command injection, path traversal, auth/authz bypass.

**Database:** use migrations, never hand-edit the live schema outside Prisma, never delete production data, protect data integrity with `CHECK` constraints and transactions where multiple tables move together.

**Decision-making:** understand the problem → analyze existing code → find root cause → consider options → pick the safest → implement → test → explain. Never guess an API shape or a database field. If information is missing, ask — don't invent.

**Testing:** every feature needs unit + integration tests; every bug fix needs a regression test. Nothing is "done" without tests passing. Invoke the `qa-tester` subagent after any feature or fix — it never writes source code, only tests and reports.

**Approval:** small bug fixes, docs updates, and minor refactors can proceed directly. Database schema changes, breaking API changes, and large architectural changes should be confirmed first — this repo has already had one total-loss incident from moving fast without version control; don't compound that by moving fast without discussion on anything hard to reverse.

## Workflow: commit and push after every verified session

The previous loss happened partly because no GitHub remote existed. Going forward: **once a session's work is implemented and verified (tests pass, lint passes, the change was actually exercised), commit and push to `origin` without waiting to be asked again.** This is a standing, durable authorization for this repo specifically — it does not extend to force-pushes, history rewrites, or anything else destructive, which still require asking first.
