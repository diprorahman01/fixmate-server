import { Router } from "express";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

/**
 * Stripe test-mode webhook. Mount after express.raw() and before the 404 handler.
 * The webhook must never rely on the signed-in user's cookies or JWT.
 */
export function createStripeWebhookRouter({ bookingsCollection, paymentsCollection }) {
  const router = Router();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) {
    router.post("/", (_req,res)=>res.status(503).json({message:"Stripe webhook not configured"}));
    return router;
  }
  const stripe = new Stripe(key);
  router.post("/", async (req,res) => {
    let event;
    try {
      const signature = req.headers["stripe-signature"];
      if (!signature || !Buffer.isBuffer(req.body)) {
        return res.status(400).send("Invalid Stripe webhook payload");
      }
      event = stripe.webhooks.constructEvent(req.body,signature,secret);
    } catch (error) {
      console.error("Webhook signature rejected:",error.message);
      return res.status(400).send("Invalid webhook signature");
    }
    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({received:true,ignored:event.type});
    }
    try {
      const session = event.data.object;
      if (session.mode !== "payment" || session.payment_status !== "paid") {
        return res.status(200).json({received:true,unpaid:true});
      }
      const bookingId = session.metadata?.bookingId;
      if (!/^[a-f\d]{24}$/i.test(bookingId||"")) {
        return res.status(400).send("Invalid booking reference");
      }
      const booking = await bookingsCollection.findOne({_id:new ObjectId(bookingId)});
      if (!booking) return res.status(500).send("Booking not found; retry later");
      const expected = Math.round(Number(booking.finalAmount)*100);
      const intent = typeof session.payment_intent === "string"?session.payment_intent:session.payment_intent?.id;
      if (
        booking.status !== "completed" ||
        booking.checkoutSessionId !== session.id ||
        session.client_reference_id !== bookingId ||
        session.metadata?.customerEmail !== booking.customerEmail ||
        session.currency !== "usd" ||
        !Number.isSafeInteger(expected) || expected < 50 ||
        expected !== session.amount_total || !intent
      ) {
        console.error("Webhook booking mismatch", {eventId:event.id,bookingId});
        return res.status(500).send("Booking/session mismatch; retry later");
      }
      const payment = {
        bookingId, customerName:booking.customerName, customerEmail:booking.customerEmail,
        technicianName:booking.technicianName,technicianEmail:booking.technicianEmail,
        serviceTitle:booking.serviceTitle, amount:expected/100,currency:"usd",
        transactionId:intent,sessionId:session.id,paidAt:new Date(),
      };
      try {
        await paymentsCollection.updateOne({bookingId},{$setOnInsert:payment},{upsert:true});
      } catch (error) {
        if (error.code!==11000) throw error;
      }
      const saved = await paymentsCollection.findOne({bookingId});
      if (!saved || saved.sessionId!==session.id || saved.transactionId!==intent || saved.amount!==payment.amount) {
        return res.status(409).send("Conflicting recorded payment");
      }
      await bookingsCollection.updateOne({_id:booking._id,status:"completed",checkoutSessionId:session.id},
        {$set:{paymentStatus:"paid",transactionId:intent,paidAt:saved.paidAt,updatedAt:new Date()}});
      return res.json({received:true});
    } catch (error) {
      console.error("Stripe webhook processing failed:",error);
      return res.status(500).send("Webhook processing failed");
    }
  });
  return router;
}
