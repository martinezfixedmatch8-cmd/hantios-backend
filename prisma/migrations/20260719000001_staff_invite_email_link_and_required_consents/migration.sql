-- AlterEnum
BEGIN;
CREATE TYPE "OtpPurpose_new" AS ENUM ('signup', 'password_reset');
ALTER TABLE "otp_challenges" ALTER COLUMN "purpose" TYPE "OtpPurpose_new" USING ("purpose"::text::"OtpPurpose_new");
ALTER TYPE "OtpPurpose" RENAME TO "OtpPurpose_old";
ALTER TYPE "OtpPurpose_new" RENAME TO "OtpPurpose";
DROP TYPE "public"."OtpPurpose_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "staff_invites" DROP CONSTRAINT "staff_invites_user_id_fkey";

-- AlterTable
ALTER TABLE "staff_invites" ADD COLUMN     "email" TEXT NOT NULL,
ADD COLUMN     "full_name" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT NOT NULL,
ADD COLUMN     "role" "UserRole" NOT NULL,
ADD COLUMN     "token" TEXT NOT NULL,
ALTER COLUMN "user_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "privacy_accepted_at" SET NOT NULL,
ALTER COLUMN "privacy_version" SET NOT NULL,
ALTER COLUMN "terms_accepted_at" SET NOT NULL,
ALTER COLUMN "terms_version" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_token_key" ON "staff_invites"("token");

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

