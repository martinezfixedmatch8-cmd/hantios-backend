-- Module 12 Session A follow-up: employees.user_id was part of the
-- confirmed Phase 0 (Q2) design but was missed during initial
-- implementation. Nullable, unique -- at most one employee record may link
-- to a given user; Postgres does not match NULL=NULL, so any number of
-- employees may still have user_id: null. ON DELETE SET NULL, matching
-- every other optional users FK in this schema (never RESTRICT a user's
-- own deletion because a payroll employee record happens to reference it).

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
