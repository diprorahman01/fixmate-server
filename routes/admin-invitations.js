import { Router } from "express";
import { randomBytes, createHash } from "node:crypto";
import { ObjectId } from "mongodb";

// Admin invitations are one-use, email-bound and expire after 24 hours.
// This router deliberately DOES NOT apply verifyAdmin globally:
// validation is public; create is admin-only; redemption requires login.
const hashCode = (code) => createHash("sha256").update(code).digest("hex");
const normalizeEmail = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (email) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validCode = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function createAdminInvitationIndexes(collection) {
  await collection.createIndex({ codeHash: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await collection.createIndex({ email: 1, usedAt: 1 });
}

export function createAdminInvitationRouter({
  invitationsCollection,
  usersCollection,
  verifyToken,
  verifyAdmin,
}) {
  const router = Router();

  // POST /api/admin-invitations/validate
  // A pre-flight check before creating a Better Auth customer account.
  // Requires both the invite code AND the invited email address.
  router.post("/validate", async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = req.body?.code;
    if (!validEmail(email) || !validCode(code)) {
      return res.status(400).json({ message: "Invalid invitation details" });
    }
    try {
      const invitation = await invitationsCollection.findOne({
        codeHash: hashCode(code), email, usedAt: null,
        expiresAt: { $gt: new Date() },
      }, { projection: { _id: 1 } });
      if (!invitation) {
        return res.status(400).json({ message: "Invitation is invalid, expired or already used" });
      }
      return res.json({ valid: true });
    } catch (error) {
      console.error("Invitation validation error:", error);
      return res.status(500).json({ message: "Unable to validate invitation" });
    }
  });

  // POST /api/admin-invitations
  // Only an authenticated, currently authorized Admin can create invites.
  router.post("/", verifyToken, verifyAdmin, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }
    try {
      const code = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await invitationsCollection.insertOne({
        codeHash: hashCode(code), email, expiresAt,
        createdAt: new Date(), createdBy: req.user.id,
        usedAt: null, usedBy: null,
      });
      // Return the plaintext code only once; only the SHA-256 hash is stored.
      return res.status(201).json({
        success: true, email, code,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      console.error("Admin invitation creation error:", error);
      return res.status(500).json({ message: "Unable to create invitation" });
    }
  });

  // POST /api/admin-invitations/redeem
  // Use the verified JWT identity, not an email or role submitted in JSON.
  router.post("/redeem", verifyToken, async (req, res) => {
    const code = req.body?.code;
    if (!validCode(code)) {
      return res.status(400).json({ message: "Invalid invitation code" });
    }
    if (req.user.role !== "customer") {
      return res.status(403).json({ message: "Only a Customer account may activate an invitation" });
    }
    try {
      const idFilters = [{ id: req.user.id }];
      if (ObjectId.isValid(req.user.id) && new ObjectId(req.user.id).toHexString() === req.user.id.toLowerCase()) {
        idFilters.push({ _id: new ObjectId(req.user.id) });
      }
      const user = await usersCollection.findOne({
        email: req.user.email, role: "customer", $or: idFilters,
      });
      if (!user) {
        return res.status(409).json({ message: "Eligible account not found; please sign in again" });
      }
      // Single atomic claim prevents two people using the same code.
      const now = new Date();
      const claimed = await invitationsCollection.findOneAndUpdate(
        {
          codeHash: hashCode(code), email: req.user.email,
          usedAt: null, expiresAt: { $gt: now },
        },
        { $set: { usedAt: now, usedBy: req.user.id } },
        { returnDocument: "after" }
      );
      if (!claimed) {
        return res.status(409).json({ message: "Invitation invalid, expired or already used" });
      }
      const changed = await usersCollection.updateOne(
        { _id: user._id, role: "customer", email: req.user.email },
        { $set: { role: "admin", updatedAt: new Date() } }
      );
      if (changed.modifiedCount !== 1) {
        // Do not reuse a consumed code after a concurrent role change.
        return res.status(409).json({ message: "Account role changed; contact the inviting Admin" });
      }
      return res.json({ success: true, role: "admin", message: "Admin access activated" });
    } catch (error) {
      console.error("Admin invitation redemption error:", error);
      return res.status(500).json({ message: "Unable to activate Admin access" });
    }
  });

  return router;
}
