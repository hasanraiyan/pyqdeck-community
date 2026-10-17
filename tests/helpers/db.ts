import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { inject } from "vitest";

export async function connectTestDb() {
  await mongoose.connect(inject("mongoUri"), { dbName: `test_${randomUUID().replaceAll("-", "")}` });
}

export async function clearTestDb() {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
}

export async function disconnectTestDb() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
