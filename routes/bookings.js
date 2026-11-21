
import { Router } from "express";
import { ObjectId } from "mongodb";

// ==========================================
// FIXMATE BOOKING ROUTES
// ==========================================

const ACTIVE_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
];

const BOOKING_STATUSES = [
  "requested",
  "accepted",
  "in-progress",
  "completed",
  "rejected",
  "cancelled",
];

const isValidId = (id) =>
  typeof id === "string" &&
  /^[0-9a-fA-F]{24}$/.test(id);

const formatBooking = (booking) => ({
  ...booking,
  _id: booking._id.toString(),
});

const validText = (value, min, max) =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.trim().length <= max;

// ==========================================
// CREATE BOOKING ROUTER
// ==========================================

export function createBookingRouter({
  bookingsCollection,
  servicesCollection,
  verifyToken,
  verifyCustomer,
  verifyTechnician,
  verifyAdmin,
}) {
  const router = Router();

  // All booking endpoints require JWT.
  router.use(verifyToken);

  // ========================================
  // CREATE REPAIR REQUEST
  // ========================================
  // POST /api/bookings
  // Customer only
  // ========================================

  router.post(
    "/bookings",
    verifyCustomer,
    async (req, res) => {
      try {
        const {
          serviceId,
          customerPhone,
          address,
          preferredDate,
          problemDescription,
        } = req.body ?? {};

        if (!isValidId(serviceId)) {
          return res.status(400).send({
            message: "Invalid service ID",
          });
        }

        if (!validText(customerPhone, 7, 25)) {
          return res.status(400).send({
            message: "Enter a valid phone number",
          });
        }

        if (!validText(address, 10, 300)) {
          return res.status(400).send({
            message:
              "Address must contain 10 to 300 characters",
          });
        }

        if (!validText(problemDescription, 20, 2000)) {
          return res.status(400).send({
            message:
              "Problem description must contain 20 to 2000 characters",
          });
        }

        // Expect a local calendar date: YYYY-MM-DD.
        if (
          typeof preferredDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)
        ) {
          return res.status(400).send({
            message: "Invalid preferred date",
          });
        }

        const date = new Date(
          `${preferredDate}T00:00:00.000Z`
        );

        if (
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !==
            preferredDate
        ) {
          return res.status(400).send({
            message: "Invalid preferred date",
          });
        }

        // Calendar dates are interpreted in
        // Bangladesh time for this project.
        const todayBD = new Intl.DateTimeFormat(
          "en-CA",
          {
            timeZone: "Asia/Dhaka",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }
        ).format(new Date());

        // Compare ISO calendar date strings.
        // Format for en-CA is YYYY-MM-DD.
        if (preferredDate < todayBD) {
          return res.status(400).send({
            message:
              "Preferred date cannot be in the past",
          });
        }

        // Only approved, available services
        // can receive a repair request.
        const service =
          await servicesCollection.findOne({
            _id: new ObjectId(serviceId),
            approvalStatus: "approved",
            isAvailable: true,
          });

        if (!service) {
          return res.status(404).send({
            message:
              "Service not found or unavailable",
          });
        }

        if (
          service.technicianEmail === req.user.email
        ) {
          return res.status(403).send({
            message:
              "You cannot request your own service",
          });
        }

        // Optional early check for a friendly
        // error. The unique MongoDB index is
        // the final concurrency protection.
        const existing =
          await bookingsCollection.findOne({
            serviceId,
            customerEmail: req.user.email,
            status: {
              $in: ACTIVE_STATUSES,
            },
          });

        if (existing) {
          return res.status(409).send({
            message:
              "You already have an active request for this service",
          });
        }

        // Copy immutable service information
        // so booking history remains readable
        // after a service is edited or deleted.
        const newBooking = {
          serviceId: service._id.toString(),
          serviceTitle: service.title,
          serviceImage: service.image,
          category: service.category,
          basePrice: service.basePrice,

          technicianName: service.technicianName,
          technicianEmail:
            service.technicianEmail,

          customerName: req.user.name,
          customerEmail: req.user.email,
          customerPhone: customerPhone.trim(),
          address: address.trim(),
          preferredDate: date,
          problemDescription:
            problemDescription.trim(),

          status: "requested",
          finalAmount: service.basePrice,
          paymentStatus: "unpaid",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result =
          await bookingsCollection.insertOne(
            newBooking
          );

        return res.status(201).send({
          success: true,
          message:
            "Repair request submitted successfully",
          booking: {
            ...newBooking,
            _id: result.insertedId.toString(),
          },
        });
      } catch (error) {
        if (error.code === 11000) {
          return res.status(409).send({
            message:
              "You already have an active request for this service",
          });
        }

        console.error(
          "Create booking error:",
          error
        );

        return res.status(500).send({
          message: "Failed to create booking",
        });
      }
    }
  );

  // ========================================
  // CUSTOMER: MY BOOKINGS
  // ========================================
  // GET /api/customer/bookings
  // ========================================

  router.get(
    "/customer/bookings",
    verifyCustomer,
    async (req, res) => {
      try {
        const bookings = await bookingsCollection
          .find({
            customerEmail: req.user.email,
          })
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .toArray();

        return res.send(
          bookings.map(formatBooking)
        );
      } catch (error) {
        console.error(
          "Customer bookings error:",
          error
        );

        return res.status(500).send({
          message: "Failed to load bookings",
        });
      }
    }
  );

  // ========================================
  // CUSTOMER: CANCEL REQUESTED BOOKING
  // ========================================
  // PATCH /api/bookings/:id/cancel
  // ========================================

  router.patch(
    "/bookings/:id/cancel",
    verifyCustomer,
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!isValidId(id)) {
          return res.status(404).send({
            message: "Booking not found",
          });
        }

        const result =
          await bookingsCollection.updateOne(
            {
              _id: new ObjectId(id),
              customerEmail: req.user.email,
              status: "requested",
            },
            {
              $set: {
                status: "cancelled",
                updatedAt: new Date(),
              },
            }
          );

        if (!result.matchedCount) {
          return res.status(409).send({
            message:
              "Booking cannot be cancelled. It may already have been processed.",
          });
        }

        return res.send({
          success: true,
          message: "Booking cancelled successfully",
        });
      } catch (error) {
        console.error(
          "Cancel booking error:",
          error
        );

        return res.status(500).send({
          message: "Failed to cancel booking",
        });
      }
    }
  );

  // ========================================
  // TECHNICIAN: INCOMING REQUESTS
  // ========================================
  // GET /api/technician/requests
  // ========================================

  router.get(
    "/technician/requests",
    verifyTechnician,
    async (req, res) => {
      try {
        const { status = "all" } = req.query;

        if (
          typeof status !== "string" ||
          !["all", ...BOOKING_STATUSES].includes(
            status
          )
        ) {
          return res.status(400).send({
            message: "Invalid booking status",
          });
        }

        const query = {
          technicianEmail: req.user.email,
        };

        if (status !== "all") {
          query.status = status;
        }

        const bookings = await bookingsCollection
          .find(query)
          .sort({
            createdAt: -1,
            _id: -1,
          })
          .toArray();

        return res.send(
          bookings.map(formatBooking)
        );
      } catch (error) {
        console.error(
          "Technician requests error:",
          error
        );

        return res.status(500).send({
          message:
            "Failed to load repair requests",
        });
      }
    }
  );

  // ========================================
  // TECHNICIAN: UPDATE JOB STATUS
  // ========================================
  // PATCH /api/technician/requests/:id/status
  // ========================================

  router.patch(
    "/technician/requests/:id/status",
    verifyTechnician,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { status, finalAmount } =
          req.body ?? {};

        if (!isValidId(id)) {
          return res.status(404).send({
            message: "Booking not found",
          });
        }

        const transitions = {
          requested: ["accepted", "rejected"],
          accepted: ["in-progress"],
          "in-progress": ["completed"],
          completed: [],
          rejected: [],
          cancelled: [],
        };

        if (
          typeof status !== "string" ||
          !BOOKING_STATUSES.includes(status) ||
          status === "cancelled"
        ) {
          return res.status(400).send({
            message: "Invalid target status",
          });
        }

        // Load only bookings owned by the
        // authenticated technician.
        const query = {
          _id: new ObjectId(id),
          technicianEmail: req.user.email,
        };

        const booking =
          await bookingsCollection.findOne(query);

        if (!booking) {
          return res.status(404).send({
            message: "Booking not found",
          });
        }

        const validNext =
          transitions[booking.status] ?? [];

        if (!validNext.includes(status)) {
          return res.status(409).send({
            message:
              `Invalid status transition: ${booking.status} to ${status}`,
          });
        }

        const updatedFields = {
          status,
          updatedAt: new Date(),
        };

        if (status === "completed") {
          if (
            typeof finalAmount !== "number" ||
            !Number.isFinite(finalAmount) ||
            finalAmount <= 0 ||
            finalAmount > 1000000
          ) {
            return res.status(400).send({
              message:
                "Final amount must be greater than zero",
            });
          }

          updatedFields.finalAmount =
            Math.round(finalAmount * 100) / 100;
        }

        // Atomic status check. If the customer
        // cancels while a technician accepts,
        // only one action can succeed.
        const result =
          await bookingsCollection.updateOne(
            {
              ...query,
              status: booking.status,
            },
            {
              $set: updatedFields,
            }
          );

        if (!result.matchedCount) {
          return res.status(409).send({
            message:
              "Booking status changed. Refresh and try again.",
          });
        }

        return res.send({
          success: true,
          message: `Booking status updated to ${status}`,
        });
      } catch (error) {
        console.error(
          "Update booking status error:",
          error
        );

        return res.status(500).send({
          message:
            "Failed to update booking status",
        });
      }
    }
  );

  // ========================================
  // ADMIN: ALL BOOKINGS (READ ONLY)
  // ========================================
  // GET /api/admin/bookings
  // ========================================

  router.get(
    "/admin/bookings",
    verifyAdmin,
    async (req, res) => {
      try {
        const { status = "all" } = req.query;

        if (
          typeof status !== "string" ||
          !["all", ...BOOKING_STATUSES].includes(
            status
          )
        ) {
          return res.status(400).send({
            message: "Invalid booking status",
          });
        }

        const query =
          status === "all" ? {} : { status };

        const bookings = await bookingsCollection
          .find(query)
          .sort({ createdAt: -1, _id: -1 })
          .toArray();

        return res.send(
          bookings.map(formatBooking)
        );
      } catch (error) {
        console.error(
          "Admin bookings error:",
          error
        );

        return res.status(500).send({
          message: "Failed to load all bookings",
        });
      }
    }
  );

  return router;
}

// ==========================================
// DATABASE INDEXES
// ==========================================

export async function createBookingIndexes(
  bookingsCollection
) {
  // Guarantees no duplicate ACTIVE booking
  // for one customer and one service.
  await bookingsCollection.createIndex(
    {
      customerEmail: 1,
      serviceId: 1,
    },
    {
      name: "unique_active_customer_service",
      unique: true,
      partialFilterExpression: {
        status: {
          $in: ACTIVE_STATUSES,
        },
      },
    }
  );

  await bookingsCollection.createIndex({
    technicianEmail: 1,
    createdAt: -1,
  });

  await bookingsCollection.createIndex({
    customerEmail: 1,
    createdAt: -1,
  });
}
