import { Router } from "express";
import { ObjectId } from "mongodb";

// ==========================================
// SESSION 9: SHARED USER PROFILE
// ==========================================

const allowedTypes = new Map([
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
]);

function userFilter(user) {
  const ids = [{ id: user.id }];
  if (ObjectId.isValid(user.id)) {
    const objectId = new ObjectId(user.id);
    if (objectId.toHexString() === user.id.toLowerCase()) {
      ids.push({ _id: objectId });
    }
  }
  return { email: user.email, $or: ids };
}

function publicProfile(user) {
  return {
    id: user.id ?? user._id?.toString() ?? "",
    name: user.name ?? "",
    email: user.email,
    role: user.role,
    image: user.image ?? "",
    phone: user.phone ?? "",
    area: user.area ?? "",
    bio: user.bio ?? "",
  };
}

function safeImageUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" &&
      ["i.ibb.co", "i.ibb.co.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isImage(buffer, type) {
  const prefix = allowedTypes.get(type);
  if (prefix && prefix.every((b, i) => buffer[i] === b)) return true;
  if (type === "image/webp") {
    return buffer.subarray(0, 4).toString() === "RIFF" &&
      buffer.subarray(8, 12).toString() === "WEBP";
  }
  return false;
}

export function createProfileRouter({ usersCollection, verifyToken }) {
  const router = Router();
  router.use(verifyToken);

  router.get("/profile", async (req, res) => {
    try {
      const user = await usersCollection.findOne(userFilter(req.user));
      if (!user) return res.status(404).json({ message: "Profile not found" });
      return res.json(publicProfile(user));
    } catch (error) {
      console.error("Profile lookup failed:", error);
      return res.status(500).json({ message: "Failed to load profile" });
    }
  });

  router.patch("/profile", async (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ message: "Invalid profile data" });
      }
      // Role, email, id and passwords must never be user-editable here.
      const allowed = ["name", "phone", "area", "bio", "image"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) {
        return res.status(400).json({ message: "Unsupported profile field" });
      }
      const changes = {};
      for (const field of allowed) {
        if (body[field] === undefined) continue;
        if (typeof body[field] !== "string") {
          return res.status(400).json({ message: `${field} must be text` });
        }
        changes[field] = body[field].trim();
      }
      if (changes.name !== undefined && (changes.name.length < 2 || changes.name.length > 80)) {
        return res.status(400).json({ message: "Name must be 2–80 characters" });
      }
      if (changes.phone !== undefined && (changes.phone.length > 25 || (changes.phone && !/^[+\d()\-\s]{7,25}$/.test(changes.phone)))) {
        return res.status(400).json({ message: "Invalid phone number" });
      }
      if (changes.area?.length > 100 || changes.bio?.length > 500) {
        return res.status(400).json({ message: "Area or biography is too long" });
      }
      if (changes.image !== undefined && changes.image !== "" && !safeImageUrl(changes.image)) {
        return res.status(400).json({ message: "Use an ImgBB photo URL" });
      }
      if (!Object.keys(changes).length) {
        return res.status(400).json({ message: "No updates provided" });
      }
      const updated = await usersCollection.findOneAndUpdate(
        userFilter(req.user),
        { $set: { ...changes, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      if (!updated) return res.status(404).json({ message: "Profile not found" });
      return res.json({ success: true, message: "Profile updated", profile: publicProfile(updated) });
    } catch (error) {
      console.error("Profile update failed:", error);
      return res.status(500).json({ message: "Failed to update profile" });
    }
  });

  // Base64 upload accepts at most 5MB decoded image. Only JPG/PNG/WebP.
  // Keep the ImgBB API key on the server, not in browser-facing environment variables.
  router.post("/profile/image", async (req, res) => {
    try {
      const { image, mimeType } = req.body ?? {};
      if (typeof image !== "string" || typeof mimeType !== "string" ||
          !["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
        return res.status(400).json({ message: "Choose a JPG, PNG or WebP image" });
      }
      if (image.length > 7_000_000 || image.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        return res.status(400).json({ message: "Invalid or oversized image" });
      }
      const bytes = Buffer.from(image, "base64");
      if (!bytes.length || bytes.length > 5 * 1024 * 1024 || !isImage(bytes, mimeType)) {
        return res.status(400).json({ message: "Invalid image content or size" });
      }
      const apiKey = process.env.IMGBB_API_KEY;
      if (!apiKey) return res.status(500).json({ message: "IMGBB_API_KEY not configured" });
      const body = new URLSearchParams({ key: apiKey, image });
      const response = await fetch("https://api.imgbb.com/1/upload", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(30000),
      });
      const result = await response.json();
      const url = result?.data?.url;
      if (!response.ok || result?.success !== true || typeof url !== "string" || !safeImageUrl(url)) {
        return res.status(502).json({ message: "ImgBB image upload failed" });
      }
      return res.json({ success: true, url });
    } catch (error) {
      console.error("ImgBB upload failed:", error);
      return res.status(502).json({ message: "Image upload failed" });
    }
  });
  return router;
}
