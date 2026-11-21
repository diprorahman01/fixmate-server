
import { Router } from "express";
import { ObjectId } from "mongodb";

// ==========================================
// FIXMATE ADMIN ROUTES
// ==========================================

const allowedStatuses = [
  "pending",
  "approved",
  "rejected",
];

const allowedRoles = [
  "customer",
  "technician",
  "admin",
];

const validId = (id) =>
  typeof id === "string" &&
  /^[0-9a-fA-F]{24}$/.test(id);

const formatService = (service) => ({
  ...service,
  _id: service._id.toString(),
});

// ==========================================
// CREATE ADMIN ROUTER
// ==========================================

export function createAdminRouter({
  usersCollection,
  servicesCollection,
  verifyToken,
  verifyAdmin,
}) {
  const router = Router();

  // Every route in this router requires
  // a valid JWT and current Admin role.
  router.use(verifyToken, verifyAdmin);

  // ========================================
  // ADMIN OVERVIEW STATISTICS
  // ========================================
  //
  // GET /api/admin/stats
  // ========================================

  router.get("/stats", async (req, res) => {
    try {
      const [
        totalUsers,
        totalTechnicians,
        pendingServices,
      ] = await Promise.all([
        usersCollection.countDocuments({}),
        usersCollection.countDocuments({
          role: "technician",
        }),
        servicesCollection.countDocuments({
          approvalStatus: "pending",
        }),
      ]);

      return res.send({
        totalUsers,
        totalTechnicians,
        pendingServices,
      });
    } catch (error) {
      console.error("Admin stats error:", error);

      return res.status(500).send({
        message: "Failed to load admin statistics",
      });
    }
  });

  // ========================================
  // GET ALL SERVICES
  // ========================================
  //
  // GET /api/admin/services
  // GET /api/admin/services?status=pending
  // ========================================

  router.get("/services", async (req, res) => {
    try {
      const { status = "all" } = req.query;

      if (
        typeof status !== "string" ||
        !["all", ...allowedStatuses].includes(
          status
        )
      ) {
        return res.status(400).send({
          message: "Invalid approval status filter",
        });
      }

      const query =
        status === "all"
          ? {}
          : { approvalStatus: status };

      // Pending first, then newest within
      // each approval status.
      const services = await servicesCollection
        .find(query)
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .toArray();

      const priority = {
        pending: 0,
        approved: 1,
        rejected: 2,
      };

      services.sort((a, b) => {
        const aPriority =
          priority[a.approvalStatus] ?? 3;

        const bPriority =
          priority[b.approvalStatus] ?? 3;

        return aPriority - bPriority;
      });

      return res.send(
        services.map(formatService)
      );
    } catch (error) {
      console.error(
        "Admin services error:",
        error
      );

      return res.status(500).send({
        message: "Failed to load services",
      });
    }
  });

  // ========================================
  // APPROVE OR REJECT SERVICE
  // ========================================
  //
  // PATCH /api/admin/services/:id/approval
  // ========================================

  router.patch(
    "/services/:id/approval",
    async (req, res) => {
      try {
        const { id } = req.params;
        const { approvalStatus } =
          req.body ?? {};

        if (!validId(id)) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        if (
          !["approved", "rejected"].includes(
            approvalStatus
          )
        ) {
          return res.status(400).send({
            message: "Invalid approval action",
          });
        }

        // Only pending services may be reviewed.
        // The conditional update prevents an
        // old admin request from overwriting
        // another review or a technician edit.
        const result =
          await servicesCollection.updateOne(
            {
              _id: new ObjectId(id),
              approvalStatus: "pending",
            },
            {
              $set: {
                approvalStatus,
                reviewedBy: req.user.email,
                reviewedAt: new Date(),
                updatedAt: new Date(),
              },
            }
          );

        if (result.matchedCount === 0) {
          return res.status(409).send({
            message:
              "This service is no longer pending. Refresh the list.",
          });
        }

        return res.send({
          success: true,
          message:
            approvalStatus === "approved"
              ? "Service approved successfully"
              : "Service rejected successfully",
        });
      } catch (error) {
        console.error(
          "Service approval error:",
          error
        );

        return res.status(500).send({
          message: "Failed to review service",
        });
      }
    }
  );

  // ========================================
  // GET ALL USERS
  // ========================================
  //
  // GET /api/admin/users
  // ========================================

  router.get("/users", async (req, res) => {
    try {
      // Exclude sensitive authentication
      // fields; only the management table
      // data is returned.
      const users = await usersCollection
        .find(
          {},
          {
            projection: {
              _id: 1,
              id: 1,
              name: 1,
              email: 1,
              role: 1,
              image: 1,
              createdAt: 1,
            },
          }
        )
        .sort({ createdAt: -1 })
        .toArray();

      return res.send(
        users.map((user) => ({
          id: String(user.id ?? user._id),
          name: user.name ?? "",
          email: user.email,
          role: user.role ?? "customer",
          image: user.image ?? null,
          createdAt: user.createdAt ?? null,
        }))
      );
    } catch (error) {
      console.error(
        "Admin users error:",
        error
      );

      return res.status(500).send({
        message: "Failed to load users",
      });
    }
  });

  // ========================================
  // CHANGE USER ROLE
  // ========================================
  //
  // PATCH /api/admin/users/:id/role
  // ========================================

  router.patch(
    "/users/:id/role",
    async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body ?? {};

        if (!allowedRoles.includes(role)) {
          return res.status(400).send({
            message: "Invalid user role",
          });
        }

        // Support Better Auth's MongoDB _id
        // and schemas using a string id.
        const idFilters = [{ id }];

        if (validId(id)) {
          idFilters.push({
            _id: new ObjectId(id),
          });
        }

        const target =
          await usersCollection.findOne({
            $or: idFilters,
          });

        if (!target) {
          return res.status(404).send({
            message: "User not found",
          });
        }

        const targetId = String(
          target.id ?? target._id
        );

        if (
          targetId === req.user.id ||
          target.email === req.user.email
        ) {
          return res.status(403).send({
            message:
              "Admins cannot change their own role",
          });
        }

        const result =
          await usersCollection.updateOne(
            {
              _id: target._id,
              role: target.role,
            },
            {
              $set: {
                role,
                updatedAt: new Date(),
              },
            }
          );

        if (result.matchedCount === 0) {
          return res.status(409).send({
            message:
              "User role changed during this request. Refresh the list.",
          });
        }

        return res.send({
          success: true,
          message: "User role updated successfully",
        });
      } catch (error) {
        console.error(
          "Admin role change error:",
          error
        );

        return res.status(500).send({
          message: "Failed to update user role",
        });
      }
    }
  );

  return router;
}
