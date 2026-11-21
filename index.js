
import express from "express";
import cors from "cors";
import "dotenv/config";
import dns from "node:dns";
import { MongoClient, ObjectId } from "mongodb";

import { createProfileRouter } from "./routes/profile.js";
import { createServiceRouter } from "./routes/services.js";
import { createAdminRouter } from "./routes/admin.js";

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
// FIXMATE EXPRESS SERVER
// ==========================================

const app = express();
const port = process.env.PORT || 5000;

// ==========================================
// EXPRESS MIDDLEWARES
// ==========================================

// Allow larger JSON payloads for profile images.
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
  console.error("MONGODB_URI is missing in .env");
  process.exit(1);
}

// Keep the DNS configuration from your file.
dns.setServers(["8.8.8.8"]);

const client = new MongoClient(uri);

const database = client.db(
  process.env.DB_NAME || "fixmatedb"
);

// ==========================================
// MONGODB COLLECTIONS
// ==========================================

const usersCollection =
  database.collection("user");

const servicesCollection =
  database.collection("services");

const bookingsCollection =
  database.collection("bookings");

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
} = createAuthMiddlewares(usersCollection);

// ==========================================
// SERVICE CATEGORIES
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
// SERVICE MODES
// ==========================================

const serviceModes = [
  "Home Visit",
  "Shop Drop-off",
];

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Escape regular-expression special characters.
function escapeRegex(text) {
  return text.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
}

// Convert MongoDB ObjectId to string.
function formatService(service) {
  return {
    ...service,
    _id: service._id.toString(),
  };
}

// ==========================================
// DEFAULT SERVER API
// ==========================================

app.get("/", (req, res) => {
  return res.send("FixMate server is running!");
});

// ==========================================
// HEALTH CHECK API
// ==========================================

app.get("/api/health", async (req, res) => {
  try {
    await database.command({ ping: 1 });

    return res.status(200).send({
      success: true,
      message: "FixMate API is healthy",
      database: "connected",
    });
  } catch (error) {
    console.error("Health check error:", error);

    return res.status(500).send({
      success: false,
      message: "MongoDB connection failed",
    });
  }
});

// ==========================================
// PUBLIC SERVICES API
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
// page
//
// Search, filtering, sorting and pagination
// are performed on the MongoDB server.
//
// Only approved and available services
// are returned.
//
// IMPORTANT:
//
// Requests WITH a page parameter return:
// {
//   services: [],
//   total: 0,
//   page: 1,
//   limit: 12,
//   totalPages: 1,
//   hasNextPage: false,
//   hasPreviousPage: false
// }
//
// Requests WITHOUT a page parameter return
// an array for backward compatibility.
//
// ==========================================

app.get("/api/services", async (req, res) => {
  try {
    const {
      search = "",
      category = "",
      serviceMode = "",
      sort = "newest",
      limit,
      page,
    } = req.query;

    // ======================================
    // STEP 1: VALIDATE QUERY PARAMETERS
    // ======================================

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

    // ======================================
    // STEP 2: BUILD MONGODB FILTER
    // ======================================

    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    // Search by service title or category.
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

    // Category filtering.
    if (category) {
      query.category = category;
    }

    // Service mode filtering.
    if (serviceMode) {
      query.serviceMode = serviceMode;
    }

    // ======================================
    // STEP 3: SERVER-SIDE SORTING
    // ======================================

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

    // ======================================
    // STEP 4: VALIDATE LIMIT
    // ======================================

    let pageSize = 12;

    if (limit !== undefined) {
      if (
        typeof limit !== "string" ||
        !/^[1-9]\d*$/.test(limit)
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid limit",
        });
      }

      pageSize = Number(limit);

      if (
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Limit must be between 1 and 100",
        });
      }
    }

    // ======================================
    // STEP 5: VALIDATE PAGE NUMBER
    // ======================================

    const usePagination = page !== undefined;
    let pageNumber = 1;

    if (usePagination) {
      if (
        typeof page !== "string" ||
        !/^[1-9]\d*$/.test(page)
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid page number",
        });
      }

      pageNumber = Number(page);

      if (
        !Number.isSafeInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > 10000
      ) {
        return res.status(400).send({
          success: false,
          message:
            "Page must be between 1 and 10000",
        });
      }
    }

    // ======================================
    // STEP 6: MONGODB PAGINATION
    // ======================================
    //
    // Pagination is enabled when the Client
    // provides the page parameter.
    //
    // Example:
    // /api/services?page=1&limit=12
    //
    // MongoDB performs:
    // find()
    // sort()
    // skip()
    // limit()
    //
    // ======================================

    if (usePagination) {
      const total =
        await servicesCollection.countDocuments(
          query
        );

      const totalPages = Math.max(
        1,
        Math.ceil(total / pageSize)
      );

      const skip = (pageNumber - 1) * pageSize;

      const services = await servicesCollection
        .find(query)
        .sort(sortOptions)
        .skip(skip)
        .limit(pageSize)
        .toArray();

      return res.status(200).send({
        services: services.map(formatService),

        total,

        page: pageNumber,

        limit: pageSize,

        totalPages,

        hasNextPage: pageNumber < totalPages,

        hasPreviousPage: pageNumber > 1,
      });
    }

    // ======================================
    // STEP 7: BACKWARD COMPATIBILITY
    // ======================================
    //
    // The homepage and older components
    // may call /api/services without page.
    //
    // Keep returning an array for those
    // components so they do not break.
    //
    // ======================================

    let cursor = servicesCollection
      .find(query)
      .sort(sortOptions);

    if (limit !== undefined) {
      cursor = cursor.limit(pageSize);
    }

    const services = await cursor.toArray();

    return res.status(200).send(
      services.map(formatService)
    );
  } catch (error) {
    console.error("Services API error:", error);

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
//
// Only approved and available services.
// ==========================================

app.get("/api/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

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
      await servicesCollection.findOne(query);

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    // Public technician information.
    const technician =
      await usersCollection.findOne(
        {
          email: service.technicianEmail,
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
});

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
      message: "Authenticated user verified",
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
// PROTECTED ROUTE MOUNTING HELPER
// ==========================================
//
// Route matching is restricted so one
// router cannot accidentally reject
// requests belonging to another router.
//
// ==========================================

function mountOnly(base, router, accepts) {
  app.use(base, (req, res, next) => {
    if (!accepts(req.method, req.path)) {
      return next();
    }

    return router(req, res, next);
  });
}

// ==========================================
// SESSION 5: TECHNICIAN SERVICES
// ==========================================

mountOnly(
  "/api",
  createServiceRouter({
    servicesCollection,
    verifyToken,
    verifyTechnician,
  }),
  (method, path) =>
    (
      method === "GET" &&
      /^\/technician\/services(?:\/[^/]+)?$/.test(
        path
      )
    ) ||
    (
      method === "POST" &&
      path === "/services"
    ) ||
    (
      ["PATCH", "DELETE"].includes(method) &&
      /^\/services\/[^/]+(?:\/availability)?$/.test(
        path
      )
    )
);

// ==========================================
// SESSION 6: ADMIN MANAGEMENT
// ==========================================

mountOnly(
  "/api/admin",
  createAdminRouter({
    usersCollection,
    servicesCollection,
    verifyToken,
    verifyAdmin,
  }),
  (method, path) =>
    (
      method === "GET" &&
      [
        "/stats",
        "/services",
        "/users",
      ].includes(path)
    ) ||
    (
      method === "PATCH" &&
      (
        /^\/services\/[^/]+\/approval$/.test(
          path
        ) ||
        /^\/users\/[^/]+\/role$/.test(path)
      )
    )
);

// ==========================================
// SESSION 7: BOOKING MANAGEMENT
// ==========================================

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
    (
      method === "POST" &&
      path === "/bookings"
    ) ||
    (
      method === "GET" &&
      [
        "/customer/bookings",
        "/technician/requests",
        "/admin/bookings",
      ].includes(path)
    ) ||
    (
      method === "PATCH" &&
      (
        /^\/bookings\/[^/]+\/cancel$/.test(
          path
        ) ||
        /^\/technician\/requests\/[^/]+\/status$/.test(
          path
        )
      )
    )
);

// ==========================================
// SESSION 8: STRIPE PAYMENT MANAGEMENT
// ==========================================

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
    (
      method === "POST" &&
      path === "/payments/create-checkout-session"
    ) ||
    (
      method === "GET" &&
      [
        "/payments/verify",
        "/customer/payments",
        "/admin/transactions",
      ].includes(path)
    )
);

// ==========================================
// SESSION 9: PROFILE MANAGEMENT
// ==========================================

mountOnly(
  "/api",
  createProfileRouter({
    usersCollection,
    verifyToken,
  }),
  (method, path) =>
    (
      ["GET", "PATCH"].includes(method) &&
      path === "/profile"
    ) ||
    (
      method === "POST" &&
      path === "/profile/image"
    )
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
  console.error("Server error:", error);

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
    // CONNECT TO MONGODB
    // ======================================

    await client.connect();

    await database.command({ ping: 1 });

    console.log(
      "Successfully connected to MongoDB!"
    );

    console.log(
      "Database:",
      database.databaseName
    );

    // ======================================
    // SERVICES INDEXES
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
    // BOOKING INDEXES
    // ======================================

    await createBookingIndexes(
      bookingsCollection
    );

    console.log(
      "Booking indexes are ready"
    );

    // ======================================
    // PAYMENT INDEXES
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
      error
    );

    await client.close().catch(console.error);

    process.exit(1);
  }
}

// ==========================================
// RUN SERVER
// ==========================================

run();
