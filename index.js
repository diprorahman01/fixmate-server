
import express from "express";
import cors from "cors";
import "dotenv/config";
import dns from "node:dns";

import { MongoClient, ObjectId } from "mongodb";
import { createProfileRouter } from "./routes/profile.js";

import {
  createServiceRouter,
} from "./routes/services.js";

import {
  createAdminRouter,
} from "./routes/admin.js";

import {
  createPaymentRouter,
  createPaymentIndexes,
} from "./routes/payments.js";

import {
  createAuthMiddlewares,
} from "./middleware/auth.js";

import {
  createBookingRouter,
  createBookingIndexes,
} from "./routes/bookings.js";

// ==========================================
// EXPRESS SETUP
// ==========================================

const app = express();

const port = process.env.PORT || 5000;

// ==========================================
// EXPRESS MIDDLEWARES
// ==========================================

// Session 9 profile photo uploads use base64 JSON (up to 5 MB decoded).
app.use(express.json({ limit: "10mb" }));

const allowedOrigins = (
  process.env.CLIENT_URL || "http://localhost:3000"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

// ==========================================
// MONGODB CONNECTION
// ==========================================

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error(
    "MONGODB_URI is missing in .env"
  );

  process.exit(1);
}

// MongoDB Atlas DNS workaround.
dns.setServers(["1.1.1.1"]);

// Create MongoDB client.
const client = new MongoClient(uri);

// Select database.
const database = client.db(
  process.env.DB_NAME || "fixmatedb"
);

// ==========================================
// MONGODB COLLECTIONS
// ==========================================

// Better Auth users.
const usersCollection =
  database.collection("user");

// Technician repair services.
const servicesCollection =
  database.collection("services");

// Session 7: Customer repair bookings.
const bookingsCollection =
  database.collection("bookings");

// ==========================================
// SESSION 8: STRIPE PAYMENTS COLLECTION
// ==========================================

const paymentsCollection =
  database.collection("payments");

// ==========================================
// JWT AUTHENTICATION MIDDLEWARES
// ==========================================

const {
  verifyToken,
  verifyCustomer,
  verifyTechnician,
  verifyAdmin,
} = createAuthMiddlewares(
  usersCollection
);

// ==========================================
// FIXMATE SERVICE CATEGORIES
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

// ==========================================
// FIXMATE SERVICE MODES
// ==========================================

const serviceModes = [
  "Home Visit",
  "Shop Drop-off",
];

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Escape special characters in search text.
const escapeRegex = (text) => {
  return text.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
};

// Convert MongoDB ObjectId to string.
const formatService = (service) => {
  return {
    ...service,
    _id: service._id.toString(),
  };
};

// ==========================================
// DEFAULT API
// ==========================================

app.get("/", (req, res) => {
  res.send("FixMate server is running!");
});

// ==========================================
// HEALTH CHECK API
// ==========================================

app.get("/api/health", async (req, res) => {
  try {
    await database.command({
      ping: 1,
    });

    return res.status(200).send({
      success: true,
      message: "FixMate API is healthy",
      database: "connected",
    });
  } catch (error) {
    console.error(
      "Health check error:",
      error
    );

    return res.status(500).send({
      success: false,
      message: "MongoDB connection failed",
    });
  }
});

// ==========================================
// GET ALL PUBLIC SERVICES
// ==========================================
//
// GET /api/services
//
// Supports:
// search
// category
// serviceMode
// sort
// limit
//
// Only approved and available services.
// ==========================================

app.get("/api/services", async (req, res) => {
  try {
    const {
      search = "",
      category = "",
      serviceMode = "",
      sort = "newest",
      limit,
    } = req.query;

    // Validate query parameters.
    if (
      typeof search !== "string" ||
      typeof category !== "string" ||
      typeof serviceMode !== "string" ||
      typeof sort !== "string"
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid query parameters",
      });
    }

    if (search.length > 100) {
      return res.status(400).send({
        success: false,
        message: "Search text is too long",
      });
    }

    if (
      category &&
      !categories.includes(category)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid service category",
      });
    }

    if (
      serviceMode &&
      !serviceModes.includes(serviceMode)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid service mode",
      });
    }

    const allowedSortOptions = [
      "newest",
      "price-asc",
      "price-desc",
    ];

    if (!allowedSortOptions.includes(sort)) {
      return res.status(400).send({
        success: false,
        message: "Invalid sort option",
      });
    }

    // Only public approved services.
    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    // Search title or category.
    if (search.trim()) {
      const safeSearch = escapeRegex(
        search.trim()
      );

      query.$or = [
        {
          title: {
            $regex: safeSearch,
            $options: "i",
          },
        },
        {
          category: {
            $regex: safeSearch,
            $options: "i",
          },
        },
      ];
    }

    // Category filter.
    if (category) {
      query.category = category;
    }

    // Service mode filter.
    if (serviceMode) {
      query.serviceMode = serviceMode;
    }

    // MongoDB sorting.
    let sortOptions = {
      createdAt: -1,
      _id: -1,
    };

    if (sort === "price-asc") {
      sortOptions = {
        basePrice: 1,
        _id: 1,
      };
    }

    if (sort === "price-desc") {
      sortOptions = {
        basePrice: -1,
        _id: -1,
      };
    }

    let cursor = servicesCollection
      .find(query)
      .sort(sortOptions);

    // Optional result limit.
    if (limit !== undefined) {
      if (typeof limit !== "string") {
        return res.status(400).send({
          success: false,
          message: "Invalid limit",
        });
      }

      const parsedLimit = Number(limit);

      if (
        !Number.isInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > 100
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Limit must be between 1 and 100",
        });
      }

      cursor = cursor.limit(parsedLimit);
    }

    const result = await cursor.toArray();

    return res.status(200).send(
      result.map(formatService)
    );
  } catch (error) {
    console.error(
      "Services API error:",
      error
    );

    return res.status(500).send({
      success: false,
      message: "Failed to load services",
    });
  }
});

// ==========================================
// GET SINGLE PUBLIC SERVICE
// ==========================================
//
// GET /api/services/:id
// ==========================================

app.get(
  "/api/services/:id",
  async (req, res) => {
    try {
      const id = req.params.id;

      if (
        typeof id !== "string" ||
        !/^[0-9a-fA-F]{24}$/.test(id)
      ) {
        return res.status(404).send({
          success: false,
          message: "Service not found",
        });
      }

      const query = {
        _id: new ObjectId(id),
        approvalStatus: "approved",
        isAvailable: true,
      };

      const service =
        await servicesCollection.findOne(
          query
        );

      if (!service) {
        return res.status(404).send({
          success: false,
          message: "Service not found",
        });
      }

      // Find public technician profile.
      const technician =
        await usersCollection.findOne(
          {
            email:
              service.technicianEmail,
            role: "technician",
          },
          {
            projection: {
              _id: 0,
              name: 1,
              image: 1,
              area: 1,
              bio: 1,
            },
          }
        );

      return res.status(200).send({
        ...formatService(service),
        technician: technician || null,
      });
    } catch (error) {
      console.error(
        "Service details error:",
        error
      );

      return res.status(500).send({
        success: false,
        message:
          "Failed to load service details",
      });
    }
  }
);

// ==========================================
// AUTHENTICATED USER API
// ==========================================
//
// GET /api/auth/me
// ==========================================

app.get(
  "/api/auth/me",
  verifyToken,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message:
        "Authenticated user verified",
      user: req.user,
    });
  }
);

// ==========================================
// CUSTOMER-ONLY TEST API
// ==========================================

app.get(
  "/api/test/customer",
  verifyToken,
  verifyCustomer,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message: "Customer access granted",
      user: req.user,
    });
  }
);

// ==========================================
// TECHNICIAN-ONLY TEST API
// ==========================================

app.get(
  "/api/test/technician",
  verifyToken,
  verifyTechnician,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message: "Technician access granted",
      user: req.user,
    });
  }
);

// ==========================================
// ADMIN-ONLY TEST API
// ==========================================

app.get(
  "/api/test/admin",
  verifyToken,
  verifyAdmin,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message: "Admin access granted",
      user: req.user,
    });
  }
);

// ==========================================
// PROTECTED ROUTERS — EXACT ROUTE SCOPING
// ==========================================
// These routers contain router.use(verifyToken) and some
// also router.use(verifyTechnician / verifyAdmin).
// A router mounted on all /api paths otherwise rejects
// unrelated requests before the next router can run.
// Only pass the router its own supported path + method.

function mountOnly(base, router, accepts) {
  app.use(base, (req, res, next) => {
    if (!accepts(req.method, req.path)) {
      return next();
    }
    return router(req, res, next);
  });
}

// Session 5: technician service operations.
mountOnly(
  "/api",
  createServiceRouter({
    servicesCollection,
    verifyToken,
    verifyTechnician,
  }),
  (method, path) =>
    (method === "GET" && /^\/technician\/services(?:\/[^/]+)?$/.test(path)) ||
    (method === "POST" && path === "/services") ||
    (["PATCH", "DELETE"].includes(method) &&
      /^\/services\/[^/]+(?:\/availability)?$/.test(path))
);

// Session 6: Admin management. The Admin router does NOT
// own /admin/bookings or /admin/transactions.
mountOnly(
  "/api/admin",
  createAdminRouter({
    usersCollection,
    servicesCollection,
    verifyToken,
    verifyAdmin,
  }),
  (method, path) =>
    (method === "GET" && ["/stats", "/services", "/users"].includes(path)) ||
    (method === "PATCH" &&
      (/^\/services\/[^/]+\/approval$/.test(path) ||
        /^\/users\/[^/]+\/role$/.test(path)))
);

// Session 7: booking requests and admin booking read-only.
mountOnly(
  "/api",
  createBookingRouter({
    bookingsCollection,
    servicesCollection,
    verifyToken,
    verifyCustomer,
    verifyTechnician,
    verifyAdmin,
  }),
  (method, path) =>
    (method === "POST" && path === "/bookings") ||
    (method === "GET" &&
      ["/customer/bookings", "/technician/requests", "/admin/bookings"].includes(path)) ||
    (method === "PATCH" &&
      (/^\/bookings\/[^/]+\/cancel$/.test(path) ||
        /^\/technician\/requests\/[^/]+\/status$/.test(path)))
);

// Session 8: Stripe payment APIs, Customer history and
// Admin transactions; other requests skip this router.
mountOnly(
  "/api",
  createPaymentRouter({
    bookingsCollection,
    paymentsCollection,
    verifyToken,
    verifyCustomer,
    verifyAdmin,
  }),
  (method, path) =>
    (method === "POST" && path === "/payments/create-checkout-session") ||
    (method === "GET" &&
      ["/payments/verify", "/customer/payments", "/admin/transactions"].includes(path))
);

// Session 9: user profile and ImgBB upload.
mountOnly(
  "/api",
  createProfileRouter({
    usersCollection,
    verifyToken,
  }),
  (method, path) =>
    (["GET", "PATCH"].includes(method) && path === "/profile") ||
    (method === "POST" && path === "/profile/image")
);

// ==========================================
// UNKNOWN API ROUTES
// ==========================================

app.use((req, res) => {
  return res.status(404).send({
    success: false,
    message: "API route not found",
  });
});

// ==========================================
// CENTRAL ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {
  console.error(
    "Server error:",
    error
  );

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).send({
    success: false,
    message: "Internal server error",
  });
});

// ==========================================
// CONNECT MONGODB AND START SERVER
// ==========================================

async function run() {
  try {
    // ======================================
    // CONNECT DATABASE
    // ======================================

    await client.connect();

    await database.command({
      ping: 1,
    });

    console.log(
      "Successfully connected to MongoDB!"
    );

    console.log(
      "Database:",
      database.databaseName
    );

    // ======================================
    // EXISTING SERVICE INDEXES
    // ======================================

    await servicesCollection.createIndex({
      approvalStatus: 1,
      isAvailable: 1,
      createdAt: -1,
    });

    await servicesCollection.createIndex({
      category: 1,
      serviceMode: 1,
    });

    await servicesCollection.createIndex({
      technicianEmail: 1,
    });

    // ======================================
    // SESSION 7: BOOKING INDEXES
    // ======================================

    await createBookingIndexes(
      bookingsCollection
    );

    console.log(
      "Booking indexes are ready"
    );

    // ======================================
    // SESSION 8: PAYMENT INDEXES
    // STEP 5.4
    // ======================================

    await createPaymentIndexes(
      paymentsCollection
    );

    console.log(
      "Payment indexes are ready"
    );

    // ======================================
    // START EXPRESS SERVER
    // ======================================

    app.listen(port, () => {
      console.log(
        `FixMate server running at http://localhost:${port}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup error:",
      error.message
    );

    await client.close().catch(console.error);

    process.exit(1);
  }
}

// ==========================================
// RUN SERVER
// ==========================================

run();
