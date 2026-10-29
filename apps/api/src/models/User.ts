import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { ASSISTANT_NAME, DEFAULT_CURRENCY } from "@nova/shared";

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    currency: { type: String, default: DEFAULT_CURRENCY },
    assistantName: { type: String, default: ASSISTANT_NAME },
    /** Home city (display name from geocoding) plus coordinates for weather. */
    city: { type: String, trim: true },
    cityLat: { type: Number },
    cityLon: { type: Number },
    /** Embedded in JWTs as `tv`; incrementing it revokes every token issued before. */
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model("User", userSchema);
