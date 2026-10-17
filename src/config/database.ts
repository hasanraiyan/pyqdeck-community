import mongoose from "mongoose";
import { logger } from "../core/utils/logger.js";
import { env } from "./env.js";

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  logger.info("MongoDB connected");
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
