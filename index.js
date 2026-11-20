
import express from "express";
import cors from "cors";
import "dotenv/config";
import dns from "node:dns";
import { MongoClient, ObjectId } from "mongodb";

// ==========================================
// EXPRESS SETUP
// ==========================================

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

// ==========================================
// MONGODB CONNECTION
// ==========================================

// MongoDB connection string from .env
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is missing in .env");
  process.exit(1);
}

// DNS workaround for the previous SRV error.
// This can be disabled later if your default
// DNS resolver starts working correctly.
dns.setServers(["1.1.1.1"]);

// Create MongoDB client - IMPORTANT FIX
const client = new MongoClient(uri);

// Select FixMate database
const database = client.db(
  process.env.DB_NAME || "fixmatedb"
);

// MongoDB collections
const usersCollection = database.collection("user");

const servicesCollection = database.collection("services");

// These collections will be used in later sessions.
// const bookingsCollection = database.collection("bookings");
// const paymentsCollection = database.collection("payments");

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

const serviceModes = [
  "Home Visit",
  "Shop Drop-off",
];

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Escape special regex characters in search text.
const escapeRegex = (text) => {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// Convert MongoDB ObjectId into a string.
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
    await database.command({ ping: 1 });

    res.status(200).send({
      success: true,
      message: "FixMate API is healthy",
      database: "connected",
    });
  } catch (error) {
    console.error("Health check error:", error);

    res.status(500).send({
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
// Supported query parameters:
// search
// category
// serviceMode
// sort
// limit
//
// Only approved and available services
// are visible to public users.
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

    // Limit search length.
    if (search.length > 100) {
      return res.status(400).send({
        success: false,
        message: "Search text is too long",
      });
    }

    // Validate category.
    if (category && !categories.includes(category)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service category",
      });
    }

    // Validate service mode.
    if (
      serviceMode &&
      !serviceModes.includes(serviceMode)
    ) {
      return res.status(400).send({
        success: false,
        message: "Invalid service mode",
      });
    }

    // Validate sorting.
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

    // Public services query.
    const query = {
      approvalStatus: "approved",
      isAvailable: true,
    };

    // Search by title or category.
    if (search.trim()) {
      const safeSearch = escapeRegex(search.trim());

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

    // Filter by category.
    if (category) {
      query.category = category;
    }

    // Filter by service mode.
    if (serviceMode) {
      query.serviceMode = serviceMode;
    }

    // Sort using MongoDB.
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

    // Build MongoDB query.
    let cursor = servicesCollection
      .find(query)
      .sort(sortOptions);

    // Optional result limit (homepage uses 6).
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
          message: "Limit must be between 1 and 100",
        });
      }

      cursor = cursor.limit(parsedLimit);
    }

    // Fetch MongoDB documents.
    const result = await cursor.toArray();

    // Keep array response compatible with
    // the existing Next.js getServices() helper.
    res.status(200).send(result.map(formatService));
  } catch (error) {
    console.error("Services API error:", error);

    res.status(500).send({
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
// Only an approved and available service
// can be viewed publicly.
// ==========================================

app.get("/api/services/:id", async (req, res) => {
  try {
    const id = req.params.id;

    // Validate MongoDB ObjectId.
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

    const service = await servicesCollection.findOne(query);

    if (!service) {
      return res.status(404).send({
        success: false,
        message: "Service not found",
      });
    }

    // Find the technician's public profile.
    const technician = await usersCollection.findOne(
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

    res.status(200).send({
      ...formatService(service),
      technician: technician || null,
    });
  } catch (error) {
    console.error("Service details error:", error);

    res.status(500).send({
      success: false,
      message: "Failed to load service details",
    });
  }
});

// ==========================================
// UNKNOWN ROUTES
// ==========================================

app.use((req, res) => {
  res.status(404).send({
    success: false,
    message: "API route not found",
  });
});

// ==========================================
// CONNECT MONGODB AND START EXPRESS
// ==========================================

async function run() {
  try {
    // Establish MongoDB connection.
    await client.connect();

    // Verify connection.
    await database.command({ ping: 1 });

    console.log("Successfully connected to MongoDB!");
    console.log("Database:", database.databaseName);

    // Create indexes for services.
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

    // Start server only after MongoDB connects.
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

run();
