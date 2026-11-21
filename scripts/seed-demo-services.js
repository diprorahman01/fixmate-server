import "dotenv/config";
import dns from "node:dns";
import { MongoClient } from "mongodb";

// Local DEMO content. No changes occur without --confirm-demo.
if (!process.argv.includes("--confirm-demo")) {
  console.error("No data written. To seed clearly marked local demo services, run node scripts/seed-demo-services.js --confirm-demo");
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
const email = process.env.DEMO_TECHNICIAN_EMAIL?.trim().toLowerCase();
if (!uri || !email) {
  console.error("Set MONGODB_URI and DEMO_TECHNICIAN_EMAIL in your local server/.env before seeding.");
  process.exit(1);
}
dns.setServers(["1.1.1.1"]);
const client = new MongoClient(uri);
const catalog = [
  ["Demo: Smartphone Screen Repair", "Smartphone", 42],
  ["Demo: Phone Battery Replacement", "Smartphone", 35],
  ["Demo: Laptop Diagnostic Service", "Laptop & PC", 50],
  ["Demo: Laptop Fan Cleaning", "Laptop & PC", 30],
  ["Demo: AC Maintenance Visit", "AC", 65],
  ["Demo: AC Cooling Problem Repair", "AC", 85],
  ["Demo: Refrigerator Cooling Check", "Refrigerator", 60],
  ["Demo: Refrigerator Door Seal Service", "Refrigerator", 38],
  ["Demo: Television Display Diagnosis", "TV", 55],
  ["Demo: Smart TV Software Support", "TV", 32],
  ["Demo: Washing Machine Inspection", "Washing Machine", 70],
  ["Demo: Home Electrical Inspection", "Electrical", 40],
];
try {
  await client.connect();
  const db=client.db(process.env.DB_NAME || "fixmatedb");
  const technician = await db.collection("user").findOne({email,role:"technician"});
  if (!technician) throw new Error("DEMO_TECHNICIAN_EMAIL must match an existing Technician account");
  const services=db.collection("services");
  let inserted=0;
  for (const [title,category,basePrice] of catalog) {
    const slug=title.toLowerCase().replace(/[^a-z0-9]+/g,"-");
    const document={
      demoSeedId:`fixmate-local-demo-${slug}`, title,category,basePrice,
      description:`DEMO LISTING FOR LOCAL TESTING ONLY. This sample ${category.toLowerCase()} service is used to test the FixMate service catalog, booking forms, and Admin / Technician dashboards. Replace with an actual approved technician listing before submission.`,
      image:"/assets/images/hero-technician.png",
      estimatedDuration:"1-2 hours",serviceMode:"Home Visit",serviceArea:technician.area || "Dhaka",
      technicianName:technician.name || "Demo Technician",technicianEmail:technician.email,
      approvalStatus:"approved",isAvailable:true,createdAt:new Date(),
    };
    const result=await services.updateOne({demoSeedId:document.demoSeedId},{$setOnInsert:document},{upsert:true});
    inserted+=result.upsertedCount;
  }
  console.log(`Local demo seed complete. ${inserted} new demo services inserted. Existing services were not changed.`);
  console.log("These are demo listings, not verified real-world services. Remove/replace before production.");
} catch (error) {console.error("Seeding failed:",error.message);process.exitCode=1;}
finally {await client.close();}
