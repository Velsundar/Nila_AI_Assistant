import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll } from "vitest";
import { connectDb } from "../db";

beforeAll(async () => {
  const uri = process.env.MONGODB_URI!;
  if (!/test/.test(uri)) throw new Error(`Refusing to run tests against non-test database: ${uri}`);
  await connectDb(uri);
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

afterEach(async () => {
  const cols = await mongoose.connection.db!.collections();
  await Promise.all(cols.map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
});
