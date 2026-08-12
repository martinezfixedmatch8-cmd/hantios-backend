import { app } from "./app";
import { env } from "./lib/config";
import { startReminderScheduler } from "./lib/reminderScheduler";
import { startStockAlertSubscriber } from "./lib/stockAlertSubscriber";
import { checkEmailDomainVerification } from "./lib/emailDomainCheck";
import { startPayrollScheduler } from "./lib/payrollScheduler";

app.listen(env.PORT, () => {
  console.log(`hantios-backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startReminderScheduler();
  startStockAlertSubscriber();
  startPayrollScheduler();
  void checkEmailDomainVerification();
});
