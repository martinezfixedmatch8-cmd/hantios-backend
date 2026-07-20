import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./lib/config";
import staffInviteRoutes from "./routes/staffInvite.routes";
import { notFoundHandler, errorHandler } from "./middleware/errorHandler";

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN_LIST ?? true }));
app.use(express.json({ limit: "100kb" }));

app.use("/staff", staffInviteRoutes);

app.use(notFoundHandler);
app.use(errorHandler);
