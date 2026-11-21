
import express from "express";
import cors from "cors";
import "dotenv/config";
import dns from "node:dns";

import { MongoClient, ObjectId } from "mongodb";

import {
  createServiceRouter,
} from "./routes/services.js";

import {
  createAdminRouter,
} from "./routes/admin.js";

import {
  createAuthMiddlewares,
} from "./middleware/auth.js";

// ==========================================
// EXPRESS SETUP
// ==========================================

const app = express();

const port = process.env.PORT || 5000;

// ==========================================
// EXPRESS MIDDLEWARES
// ==========================================

app.use(express.json());

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

// The DNS workaround previously needed
// for your MongoDB Atlas connection.
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

// Better Auth's user collection.
const usersCollection =
  database.collection("user");

// Technician repair services.
const servicesCollection =
  database.collection("services");

// These collections will be used when
// implementing bookings and payments.
// const bookingsCollection =
//   database.collection("bookings");

// const paymentsCollection =
//   database.collection("payments");

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
// ADMIN MANAGEMENT ROUTES
// ==========================================

app.use(
  "/api/admin",
  createAdminRouter({
    usersCollection,
    servicesCollection,
    verifyToken,
    verifyAdmin,
  })
);

// ==========================================
// TECHNICIAN SERVICE MANAGEMENT ROUTES
// ==========================================

app.use(
  "/api",
  createServiceRouter({
    servicesCollection,
    verifyToken,
    verifyTechnician,
  })
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

// Escape special characters in search
// text before creating a MongoDB regex.
const escapeRegex = (text) => {
  return text.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
};

// Convert MongoDB ObjectId to a string
// for the Next.js frontend.
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
  res.send(
    "FixMate server is running!"
  );
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
// Only approved and available services
// can appear publicly.
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

    // ======================================
    // VALIDATE QUERY PARAMETERS
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

    if (
      !allowedSortOptions.includes(sort)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid sort option",
      });
    }

    // ======================================
    // PUBLIC SERVICE VISIBILITY
    // ======================================

    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    // ======================================
    // SEARCH BY TITLE OR CATEGORY
    // ======================================

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

    // ======================================
    // CATEGORY FILTER
    // ======================================

    if (category) {
      query.category = category;
    }

    // ======================================
    // SERVICE MODE FILTER
    // ======================================

    if (serviceMode) {
      query.serviceMode = serviceMode;
    }

    // ======================================
    // SORTING
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
    // MONGODB QUERY
    // ======================================

    let cursor = servicesCollection
      .find(query)
      .sort(sortOptions);

    // ======================================
    // OPTIONAL RESULT LIMIT
    // ======================================

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

      cursor = cursor.limit(
        parsedLimit
      );
    }

    // ======================================
    // FETCH SERVICES
    // ======================================

    const result =
      await cursor.toArray();

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
//
// Approved and available services only.
// ==========================================

app.get(
  "/api/services/:id",
  async (req, res) => {
    try {
      const id = req.params.id;

      // ====================================
      // VALIDATE OBJECT ID
      // ====================================

      if (
        typeof id !== "string" ||
        !/^[0-9a-fA-F]{24}$/.test(id)
      ) {
        return res.status(404).send({
          success: false,
          message: "Service not found",
        });
      }

      // ====================================
      // FIND APPROVED SERVICE
      // ====================================

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

      // ====================================
      // TECHNICIAN PUBLIC PROFILE
      // ====================================

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
//
// Requires a valid JWT.
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
//
// GET /api/test/customer
//
// Requires:
// verifyToken
// verifyCustomer
// ==========================================

app.get(
  "/api/test/customer",
  verifyToken,
  verifyCustomer,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message:
        "Customer access granted",
      user: req.user,
    });
  }
);

// ==========================================
// TECHNICIAN-ONLY TEST API
// ==========================================
//
// GET /api/test/technician
//
// Requires:
// verifyToken
// verifyTechnician
// ==========================================

app.get(
  "/api/test/technician",
  verifyToken,
  verifyTechnician,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message:
        "Technician access granted",
      user: req.user,
    });
  }
);

// ==========================================
// ADMIN-ONLY TEST API
// ==========================================
//
// GET /api/test/admin
//
// Requires:
// verifyToken
// verifyAdmin
// ==========================================

app.get(
  "/api/test/admin",
  verifyToken,
  verifyAdmin,
  (req, res) => {
    return res.status(200).send({
      success: true,
      message:
        "Admin access granted",
      user: req.user,
    });
  }
);

// ==========================================
// UNKNOWN ROUTES
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

    // Check MongoDB connection.
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
    // MONGODB INDEXES
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
    // START EXPRESS SERVER
    // ======================================

    app.listen(port, () => {
      console.log(
        `FixMate server running at http://localhost:${port}`
      );
    });
  } catch (error) {
    console.error(
      "MongoDB connection error:",
      error.message
    );

    process.exit(1);
  }
}

// ==========================================
// RUN SERVER
// ==========================================

run();
