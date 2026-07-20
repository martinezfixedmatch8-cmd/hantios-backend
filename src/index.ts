import { app } from "./app";
import { env } from "./lib/config";

app.listen(env.PORT, () => {
  console.log(`hantios-backend listening on port ${env.PORT} (${env.NODE_ENV})`);
});
