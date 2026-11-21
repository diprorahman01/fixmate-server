import "dotenv/config";
import dns from "node:dns";
import { MongoClient } from "mongodb";

dns.setServers(["1.1.1.1"]);
const uri = process.env.MONGODB_URI;
if (!uri) { console.error("MONGODB_URI is missing from server/.env"); process.exit(1); }
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(process.env.DB_NAME || "fixmatedb");
  const users = db.collection("user");
  const services = db.collection("services");
  const bookings = db.collection("bookings");
  const payments = db.collection("payments");
  const [totalUsers, admins, technicians, customers, serviceCount,
    approved, available, publicServices, bookingCount, paymentCount] = await Promise.all([
    users.countDocuments({}), users.countDocuments({role:"admin"}),
    users.countDocuments({role:"technician"}), users.countDocuments({role:"customer"}),
    services.countDocuments({}), services.countDocuments({approvalStatus:"approved"}),
    services.countDocuments({isAvailable:true}),
    services.countDocuments({approvalStatus:"approved",isAvailable:true}),
    bookings.countDocuments({}), payments.countDocuments({}),
  ]);
  console.log(JSON.stringify({database:db.databaseName, users:{totalUsers,admins,technicians,customers},
    services:{serviceCount,approved,available,publicServices},bookingCount,paymentCount},null,2));
  if (!admins) console.log("ACTION: No admin account exists. Review scripts/promote-admin.js and ADMIN_EMAIL in .env.");
  if (!publicServices) console.log("ACTION: Create a Technician service and approve it as Admin; or use the optional local demo seeder.");
  const adminList = await users.find({role:"admin"},{projection:{email:1,_id:0}}).toArray();
  console.log("Admin account emails:",adminList.map(x=>x.email).join(", ") || "none");
} catch (error) {console.error("Database check failed:",error.message);process.exitCode=1;}
finally {await client.close();}
