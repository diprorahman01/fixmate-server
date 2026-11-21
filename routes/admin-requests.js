import { Router } from "express";
import { ObjectId } from "mongodb";

// New users can request Admin access, but cannot assign themselves roles.
// Every decision is verified against the authenticated MongoDB Admin identity.
export function createAdminRequestRouter({requestsCollection,usersCollection,verifyToken,verifyCustomer,verifyAdmin}) {
  const router=Router();
  router.use(verifyToken);

  router.post("/request",verifyCustomer,async(req,res)=>{
    try {
      const user=await usersCollection.findOne({email:req.user.email,role:"customer",$or:[{id:req.user.id},...(ObjectId.isValid(req.user.id)?[{_id:new ObjectId(req.user.id)}]:[])]});
      if(!user)return res.status(403).json({message:"Only registered Customer accounts can request Admin access"});
      const userId=String(user.id??user._id);
      const previous=await requestsCollection.findOne({userId});
      if(previous)return res.json({status:previous.status});
      try {
        await requestsCollection.insertOne({userId,email:user.email,name:user.name,status:"pending",createdAt:new Date(),reviewedAt:null,reviewedBy:null});
      } catch(e) { if(e.code!==11000)throw e; }
      const saved=await requestsCollection.findOne({userId});
      return res.status(201).json({status:saved.status});
    }catch(e){console.error("Admin request error:",e);return res.status(500).json({message:"Could not submit Admin request"});}
  });

  router.get("/",verifyAdmin,async(req,res)=>{
    try{const items=await requestsCollection.find({status:"pending"}).sort({createdAt:1}).limit(100).toArray();return res.json(items.map(r=>({...r,_id:r._id.toString()})));}
    catch(e){console.error("Admin requests read error:",e);return res.status(500).json({message:"Could not load requests"});}
  });

  router.patch("/:id/decision",verifyAdmin,async(req,res)=>{
    const {id}=req.params;const {decision}=req.body??{};
    if(!ObjectId.isValid(id)||!["approve","reject"].includes(decision))return res.status(400).json({message:"Invalid request"});
    try {
      const _id=new ObjectId(id);const item=await requestsCollection.findOne({_id,status:"pending"});
      if(!item)return res.status(409).json({message:"Request was already reviewed"});
      const user=await usersCollection.findOne({email:item.email,role:"customer",$or:[{id:item.userId},...(ObjectId.isValid(item.userId)?[{_id:new ObjectId(item.userId)}]:[])]});
      if(!user)return res.status(409).json({message:"Applicant no longer has an eligible Customer account"});
      // Claim the request first to avoid simultaneous conflicting decisions.
      const claim=await requestsCollection.updateOne({_id,status:"pending"},{$set:{status:"processing",reviewedBy:req.user.id,reviewedAt:new Date()}});
      if(claim.modifiedCount!==1)return res.status(409).json({message:"Request was already reviewed"});
      if(decision==="reject") {
        await requestsCollection.updateOne({_id,status:"processing"},{$set:{status:"rejected"}});
        return res.json({success:true,message:"Admin request rejected"});
      }
      try {
        const updated=await usersCollection.updateOne({_id:user._id,email:item.email,role:"customer"},{$set:{role:"admin",updatedAt:new Date()}});
        if(updated.modifiedCount!==1)throw new Error("Account role changed during approval");
        await requestsCollection.updateOne({_id,status:"processing"},{$set:{status:"approved"}});
        return res.json({success:true,message:"Admin access approved. The user can sign in again."});
      } catch(e) {
        // A DB failure after role promotion needs administrator review, never automatic elevation.
        console.error("Admin approval partially failed; verify DB state:",id,e);
        return res.status(500).json({message:"Approval requires administrator review; check user role"});
      }
    }catch(e){console.error("Admin approval error:",e);return res.status(500).json({message:"Could not review request"});}
  });
  return router;
}

export async function createAdminRequestIndexes(collection) {
  await collection.createIndex({userId:1},{unique:true,name:"admin_request_user_unique"});
  await collection.createIndex({status:1,createdAt:1});
}
