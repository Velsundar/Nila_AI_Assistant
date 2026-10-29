import mongoose from "mongoose";
import { config } from "./config";

mongoose.set("strictQuery", true);

export async function connectDb(uri = config.mongoUri): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  return mongoose;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
