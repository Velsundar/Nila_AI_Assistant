import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/**
 * Pick or photograph a receipt and return it as a JPEG data URL small enough for
 * POST /api/receipts/scan (server limit ~4 MB decoded). Returns null if the user cancelled.
 * Works in Expo Go (image-picker + image-manipulator are bundled there).
 */

const MAX_EDGE = 1600;
const MAX_BYTES = 3.5 * 1024 * 1024; // a little headroom under the ~4 MB limit

const approxBytes = (b64: string) => Math.floor((b64.length * 3) / 4);

export async function pickReceiptImage(source: "camera" | "library"): Promise<string | null> {
  const perm =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error(
      source === "camera"
        ? "Camera permission was denied. Enable it in your phone's Settings, or pick a photo instead."
        : "Photo library permission was denied. Enable it in your phone's Settings, or use the camera.",
    );
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    base64: true,
    quality: 0.6,
    exif: false,
    allowsEditing: false,
  };
  const result =
    source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];

  const tooBig = Math.max(asset.width, asset.height) > MAX_EDGE;
  if (asset.base64 && !tooBig && approxBytes(asset.base64) <= MAX_BYTES) {
    const mime = asset.mimeType?.startsWith("image/") ? asset.mimeType : "image/jpeg";
    return `data:${mime};base64,${asset.base64}`;
  }

  // Downscale (longest edge → 1600px) and re-encode as JPEG; step quality down if still too big.
  const resize = asset.width >= asset.height ? { width: Math.min(asset.width, MAX_EDGE) } : { height: Math.min(asset.height, MAX_EDGE) };
  const ctx = ImageManipulator.manipulate(asset.uri);
  ctx.resize(resize);
  const image = await ctx.renderAsync();
  for (const compress of [0.6, 0.45, 0.3]) {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
    if (saved.base64 && approxBytes(saved.base64) <= MAX_BYTES) return `data:image/jpeg;base64,${saved.base64}`;
  }
  throw new Error("That photo is too large to scan. Try again a little further from the receipt.");
}
