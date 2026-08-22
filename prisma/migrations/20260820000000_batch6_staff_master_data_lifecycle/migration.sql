-- Batch 6 remediation (HNT2-HR-001, HNT2-MD-001, HNT2-MASTER-001,
-- HNT2-EXP-001). Every ADD COLUMN below is DEFAULT-backed, so every
-- existing row stays correct with zero backfill: departments/positions/tags
-- get status='active' (nothing was ever archived before this migration
-- existed, so 'active' is simply true for every live row -- confirmed by
-- the fact neither table had a status column at all until now); version
-- starts at 0 everywhere (no optimistic-locking history exists yet).
--
-- The Phase 1 read-only duplicate audit (run against the shared production
-- database, the one narrowly-scoped exception to this repo's own
-- TEST_DATABASE_URL-only rule) returned ZERO duplicate groups for both
-- departments.name and positions.title under the normalized comparison
-- below -- this is what makes the new partial unique indexes on those two
-- tables safe to add.

-- 1. Lifecycle columns, safe defaults (departments, positions, tags).
ALTER TABLE "departments" ADD COLUMN "status" "RecordStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "departments" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "positions" ADD COLUMN "status" "RecordStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "positions" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "tags" ADD COLUMN "status" "RecordStatus" NOT NULL DEFAULT 'active';
ALTER TABLE "tags" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- 1b. Additive optimistic-locking column only (branches, payment_methods --
-- both already have a real `status` column, untouched here).
ALTER TABLE "branches" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_methods" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

-- 2. Departments/positions -- brand-new active-only, normalized (case- and
-- whitespace-insensitive) partial functional unique indexes. Prisma's
-- schema DSL cannot express a functional index, so these are hand-added
-- raw SQL, same recipe as every other partial/functional unique index in
-- this repo's own migration history (Customer Records' active-only phone
-- uniqueness, Batch 4's supplier-payment-instruction default uniqueness).
-- Authorized specifically because the Phase 1 audit above found zero
-- existing duplicate groups under this exact normalization.
CREATE UNIQUE INDEX "ux_departments_business_id_active_name"
  ON "departments" ("business_id", (lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g')))))
  WHERE "status" = 'active';

CREATE UNIQUE INDEX "ux_positions_business_id_active_title"
  ON "positions" ("business_id", (lower(btrim(regexp_replace("title", '[[:space:]]+', ' ', 'g')))))
  WHERE "status" = 'active';

-- 3. Tags/expense_categories -- narrow the EXISTING global (business_id,
-- name) uniqueness down to active-only, preserving exact-match semantics
-- (no normalization added -- deliberately different from departments/
-- positions per the locked decision). Strict create-before-drop ordering:
-- the replacement partial index is created FIRST, so the table is never
-- left with zero uniqueness protection at any point; the old global index
-- is dropped only once the replacement already exists.
--
-- tags_business_id_name_key / expense_categories_business_id_name_key were
-- both confirmed, by reading the actual committed migration files
-- (20260726194817_expense_module_core, 20260727085324_expense_workflow_
-- recurrence_tags), to be plain CREATE UNIQUE INDEX objects, never
-- ALTER TABLE ... ADD CONSTRAINT ... UNIQUE -- so DROP INDEX is the correct
-- statement, not ALTER TABLE ... DROP CONSTRAINT (which would fail: no
-- such object exists in pg_constraint for either).
CREATE UNIQUE INDEX "ux_tags_business_id_active_name"
  ON "tags" ("business_id", "name")
  WHERE "status" = 'active';

DROP INDEX "tags_business_id_name_key";

CREATE UNIQUE INDEX "ux_expense_categories_business_id_active_name"
  ON "expense_categories" ("business_id", "name")
  WHERE "active" = true;

DROP INDEX "expense_categories_business_id_name_key";
