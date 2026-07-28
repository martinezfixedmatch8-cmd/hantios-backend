import { app } from "./app";
import { env } from "./lib/config";
import { startReminderScheduler } from "./lib/reminderScheduler";
import { startStockAlertSubscriber } from "./lib/stockAlertSubscriber";

app.listen(env.PORT, () => {
  console.log(`hantios-backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startReminderScheduler();
  startStockAlertSubscriber();
});
