
import { Router } from "express";
import { ObjectId } from "mongodb";

// ==========================================
// FIXMATE SERVICE ROUTES
// ==========================================

const categories = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];

const serviceModes = [
  "Home Visit",
  "Shop Drop-off",
];

// ==========================================
// HELPER FUNCTIONS
// ==========================================

const isValidId = (id) => {
  return /^[0-9a-fA-F]{24}$/.test(id);
};

const formatService = (service) => ({
  ...service,
  _id: service._id.toString(),
});

const isImgBBImage = (value) => {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      ["i.ibb.co", "i.ibb.co.com"].includes(
        url.hostname
      )
    );
  } catch {
    return false;
  }
};

// ==========================================
// SERVICE VALIDATION
// ==========================================

function validateService(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return "Invalid service information";
  }

  const {
    title,
    category,
    description,
    image,
    basePrice,
    estimatedDuration,
    serviceMode,
    serviceArea,
  } = body;

  if (
    typeof title !== "string" ||
    title.trim().length < 5 ||
    title.trim().length > 120
  ) {
    return "Title must contain 5 to 120 characters";
  }

  if (!categories.includes(category)) {
    return "Invalid category";
  }

  if (
    typeof description !== "string" ||
    description.trim().length < 20 ||
    description.trim().length > 3000
  ) {
    return "Description must contain 20 to 3000 characters";
  }

  if (
    typeof image !== "string" ||
    !isImgBBImage(image)
  ) {
    return "A valid ImgBB service image is required";
  }

  if (
    typeof basePrice !== "number" ||
    !Number.isFinite(basePrice) ||
    basePrice <= 0 ||
    basePrice > 1000000
  ) {
    return "Base price must be a positive number";
  }

  if (
    typeof estimatedDuration !== "string" ||
    !estimatedDuration.trim() ||
    estimatedDuration.length > 100
  ) {
    return "Estimated duration is required";
  }

  if (!serviceModes.includes(serviceMode)) {
    return "Invalid service mode";
  }

  if (
    typeof serviceArea !== "string" ||
    !serviceArea.trim() ||
    serviceArea.length > 150
  ) {
    return "Service area is required";
  }

  return null;
}

// ==========================================
// CREATE SERVICE ROUTER
// ==========================================

export function createServiceRouter({
  servicesCollection,
  verifyToken,
  verifyTechnician,
}) {
  const router = Router();

  // Every route defined here is for
  // logged-in technicians only.
  router.use(verifyToken, verifyTechnician);

  // ========================================
  // GET MY SERVICES
  // ========================================
  //
  // GET /api/technician/services
  // ========================================

  router.get(
    "/technician/services",
    async (req, res) => {
      try {
        const services = await servicesCollection
          .find({
            technicianEmail: req.user.email,
          })
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .toArray();

        return res.status(200).send(
          services.map(formatService)
        );
      } catch (error) {
        console.error(
          "My services error:",
          error
        );

        return res.status(500).send({
          message: "Failed to load your services",
        });
      }
    }
  );

  // ========================================
  // GET ONE OWNED SERVICE
  // ========================================
  //
  // GET /api/technician/services/:id
  // ========================================

  router.get(
    "/technician/services/:id",
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidId(id)) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        const service =
          await servicesCollection.findOne({
            _id: new ObjectId(id),
            technicianEmail: req.user.email,
          });

        if (!service) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        return res.send(formatService(service));
      } catch (error) {
        console.error(
          "Service lookup error:",
          error
        );

        return res.status(500).send({
          message: "Failed to load service",
        });
      }
    }
  );

  // ========================================
  // CREATE SERVICE
  // ========================================
  //
  // POST /api/services
  // ========================================

  router.post(
    "/services",
    async (req, res) => {
      try {
        const errorMessage =
          validateService(req.body);

        if (errorMessage) {
          return res.status(400).send({
            message: errorMessage,
          });
        }

        const {
          title,
          category,
          description,
          image,
          basePrice,
          estimatedDuration,
          serviceMode,
          serviceArea,
        } = req.body;

        // These ownership fields MUST come
        // from the authenticated JWT identity.
        const newService = {
          title: title.trim(),
          category,
          description: description.trim(),
          image,
          basePrice,
          estimatedDuration:
            estimatedDuration.trim(),
          serviceMode,
          serviceArea: serviceArea.trim(),

          technicianName: req.user.name,
          technicianEmail: req.user.email,

          approvalStatus: "pending",
          isAvailable: true,
          createdAt: new Date(),
        };

        const result =
          await servicesCollection.insertOne(
            newService
          );

        return res.status(201).send({
          success: true,
          message:
            "Service submitted for admin approval",
          service: {
            ...newService,
            _id: result.insertedId.toString(),
          },
        });
      } catch (error) {
        console.error(
          "Create service error:",
          error
        );

        return res.status(500).send({
          message: "Failed to create service",
        });
      }
    }
  );

  // ========================================
  // UPDATE OWN SERVICE
  // ========================================
  //
  // PATCH /api/services/:id
  // ========================================

  router.patch(
    "/services/:id",
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidId(id)) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        const errorMessage =
          validateService(req.body);

        if (errorMessage) {
          return res.status(400).send({
            message: errorMessage,
          });
        }

        const {
          title,
          category,
          description,
          image,
          basePrice,
          estimatedDuration,
          serviceMode,
          serviceArea,
        } = req.body;

        const query = {
          _id: new ObjectId(id),
          technicianEmail: req.user.email,
        };

        const updatedData = {
          title: title.trim(),
          category,
          description: description.trim(),
          image,
          basePrice,
          estimatedDuration:
            estimatedDuration.trim(),
          serviceMode,
          serviceArea: serviceArea.trim(),

          // Edited listings require
          // fresh admin approval.
          approvalStatus: "pending",
          updatedAt: new Date(),
        };

        const result =
          await servicesCollection.updateOne(
            query,
            {
              $set: updatedData,
            }
          );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            message:
              "Service not found or not owned by you",
          });
        }

        return res.send({
          success: true,
          message:
            "Service updated and sent for approval",
        });
      } catch (error) {
        console.error(
          "Update service error:",
          error
        );

        return res.status(500).send({
          message: "Failed to update service",
        });
      }
    }
  );

  // ========================================
  // TOGGLE SERVICE AVAILABILITY
  // ========================================
  //
  // PATCH /api/services/:id/availability
  // ========================================

  router.patch(
    "/services/:id/availability",
    async (req, res) => {
      try {
        const { id } = req.params;

        if (
          !isValidId(id) ||
          typeof req.body?.isAvailable !==
            "boolean"
        ) {
          return res.status(400).send({
            message: "Invalid availability request",
          });
        }

        const result =
          await servicesCollection.updateOne(
            {
              _id: new ObjectId(id),
              technicianEmail: req.user.email,
            },
            {
              $set: {
                isAvailable:
                  req.body.isAvailable,
                updatedAt: new Date(),
              },
            }
          );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        return res.send({
          success: true,
          message:
            "Availability updated successfully",
        });
      } catch (error) {
        console.error(
          "Availability error:",
          error
        );

        return res.status(500).send({
          message: "Unable to update availability",
        });
      }
    }
  );

  // ========================================
  // DELETE OWN SERVICE
  // ========================================
  //
  // DELETE /api/services/:id
  // ========================================

  router.delete(
    "/services/:id",
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidId(id)) {
          return res.status(404).send({
            message: "Service not found",
          });
        }

        const result =
          await servicesCollection.deleteOne({
            _id: new ObjectId(id),
            technicianEmail: req.user.email,
          });

        if (result.deletedCount === 0) {
          return res.status(404).send({
            message:
              "Service not found or not owned by you",
          });
        }

        return res.send({
          success: true,
          message: "Service deleted successfully",
        });
      } catch (error) {
        console.error(
          "Delete service error:",
          error
        );

        return res.status(500).send({
          message: "Failed to delete service",
        });
      }
    }
  );

  return router;
}
