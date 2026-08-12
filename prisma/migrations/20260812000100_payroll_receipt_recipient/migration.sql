-- AlterTable
ALTER TABLE "businesses" ALTER COLUMN "business_day_end_time" SET DEFAULT '23:59:59'::time,
ALTER COLUMN "business_day_start_time" SET DEFAULT '00:00:00'::time;

-- AlterTable
ALTER TABLE "receipt_delivery_attempts" ADD COLUMN     "employee_id" TEXT;

-- AddForeignKey
ALTER TABLE "receipt_delivery_attempts" ADD CONSTRAINT "receipt_delivery_attempts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

