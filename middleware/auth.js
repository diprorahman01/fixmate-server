
import { jwtVerify } from "jose";
import { ObjectId } from "mongodb";

// ==========================================
// JWT CONFIGURATION
// ==========================================

const JWT_ISSUER = "fixmate-auth";
const JWT_AUDIENCE = "fixmate-api";

// ==========================================
// CREATE AUTH MIDDLEWARES
// ==========================================

export function createAuthMiddlewares(
  usersCollection
) {
  // ========================================
  // VERIFY JWT TOKEN
  // ========================================

  const verifyToken = async (req, res, next) => {
    const authorization =
      req.headers.authorization;

    // Check whether a token was provided.
    if (
      !authorization ||
      !authorization.startsWith("Bearer ")
    ) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized: Token missing",
      });
    }

    const token =
      authorization.slice(7).trim();

    if (!token) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized: Invalid token",
      });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret || secret.length < 32) {
      console.error(
        "JWT_SECRET is missing or too short"
      );

      return res.status(500).send({
        success: false,
        message: "Server configuration error",
      });
    }

    let payload;

    // ======================================
    // VERIFY JWT SIGNATURE
    // ======================================

    try {
      const verified = await jwtVerify(
        token,
        new TextEncoder().encode(secret),
        {
          algorithms: ["HS256"],
          issuer: JWT_ISSUER,
          audience: JWT_AUDIENCE,
        }
      );

      payload = verified.payload;
    } catch {
      return res.status(401).send({
        success: false,
        message:
          "Unauthorized: Invalid or expired token",
      });
    }

    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string"
    ) {
      return res.status(401).send({
        success: false,
        message: "Unauthorized: Invalid identity",
      });
    }

    // ======================================
    // VERIFY USER IN MONGODB
    // ======================================

    try {
      // Better Auth's MongoDB adapter normally
      // uses MongoDB _id. Some database schemas
      // also contain a separate string id.
      const idFilters = [
        { id: payload.sub },
      ];

      if (ObjectId.isValid(payload.sub)) {
        const objectId = new ObjectId(
          payload.sub
        );

        if (
          objectId.toHexString() ===
          payload.sub.toLowerCase()
        ) {
          idFilters.push({
            _id: objectId,
          });
        }
      }

      // Require BOTH matching user ID
      // and verified email.
      const user = await usersCollection.findOne({
        email: payload.email,
        $or: idFilters,
      });

      if (!user) {
        return res.status(401).send({
          success: false,
          message:
            "Unauthorized: User not found",
        });
      }

      // Check current role in MongoDB.
      const allowedRoles = [
        "customer",
        "technician",
        "admin",
      ];

      if (!allowedRoles.includes(user.role)) {
        return res.status(403).send({
          success: false,
          message:
            "Forbidden: Invalid account role",
        });
      }

      // Store authenticated identity.
      req.user = {
        id: payload.sub,
        email: user.email,
        name: user.name,
        role: user.role,
      };

      next();
    } catch (error) {
      console.error(
        "Authentication database error:",
        error
      );

      return res.status(500).send({
        success: false,
        message: "Authentication service error",
      });
    }
  };

  // ========================================
  // VERIFY CUSTOMER
  // ========================================

  const verifyCustomer = (req, res, next) => {
    if (req.user?.role !== "customer") {
      return res.status(403).send({
        success: false,
        message: "Forbidden: Customers only",
      });
    }

    next();
  };

  // ========================================
  // VERIFY TECHNICIAN
  // ========================================

  const verifyTechnician = (req, res, next) => {
    if (req.user?.role !== "technician") {
      return res.status(403).send({
        success: false,
        message: "Forbidden: Technicians only",
      });
    }

    next();
  };

  // ========================================
  // VERIFY ADMIN
  // ========================================

  const verifyAdmin = (req, res, next) => {
    if (req.user?.role !== "admin") {
      return res.status(403).send({
        success: false,
        message: "Forbidden: Admins only",
      });
    }

    next();
  };

  // ========================================
  // EXPORT MIDDLEWARES
  // ========================================

  return {
    verifyToken,
    verifyCustomer,
    verifyTechnician,
    verifyAdmin,
  };
}
