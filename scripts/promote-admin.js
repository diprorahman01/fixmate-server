
import "dotenv/config";
import dns from "node:dns";
import { MongoClient } from "mongodb";

// ==========================================
// ONE-TIME FIXMATE ADMIN BOOTSTRAP
// ==========================================

// Local MongoDB Atlas DNS workaround.
dns.setServers(["1.1.1.1"]);

const uri = process.env.MONGODB_URI;
const email = process.env.ADMIN_EMAIL;

if (!uri || !email) {
  console.error(
    "MONGODB_URI and ADMIN_EMAIL are required"
  );

  process.exit(1);
}

const client = new MongoClient(uri);

async function promoteAdmin() {
  try {
    await client.connect();

    const database = client.db(
      process.env.DB_NAME || "fixmatedb"
    );

    const users = database.collection("user");

    const normalizedEmail =
      email.trim().toLowerCase();

    const user = await users.findOne({
      email: normalizedEmail,
    });

    if (!user) {
      throw new Error(
        "Account not found. Register it in FixMate first."
      );
    }

    if (user.role === "admin") {
      console.log("Account is already an admin.");
      return;
    }

    // Only bootstrap when the application has
    // no existing admin account.
    const existingAdmin = await users.findOne({
      role: "admin",
    });

    if (existingAdmin) {
      throw new Error(
        "An admin already exists. Use the protected Admin Users page instead."
      );
    }

    const result = await users.updateOne(
      {
        _id: user._id,
        role: user.role,
      },
      {
        $set: {
          role: "admin",
          updatedAt: new Date(),
        },
      }
    );

    if (result.modifiedCount !== 1) {
      throw new Error(
        "Admin promotion did not complete"
      );
    }

    console.log(
      "FixMate application Admin created successfully"
    );
  } catch (error) {
    console.error(
      "Admin setup error:",
      error.message
    );

    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

await promoteAdmin();
