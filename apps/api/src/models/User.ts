import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    currency: { type: String, default: DEFAULT_CURRENCY },
    assistantName: { type: String, default: ASSISTANT_NAME },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model("User", userSchema);
