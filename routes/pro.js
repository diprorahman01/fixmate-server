import { Router } from "express";
import Stripe from "stripe";

// Technician billing. The server selects the price; never accept a price from a client.
export function createProRouter({ usersCollection, servicesCollection, verifyToken, verifyTechnician }) {
  const router = Router();
  router.use(verifyToken, verifyTechnician);
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const priceId = process.env.STRIPE_PRO_PRICE_ID;
  const appUrl = (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");

  const getUser = (req) => usersCollection.findOne({ email: req.user.email, role: "technician" });
  router.get("/technician/pro", async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user) return res.status(404).json({ message: "Technician not found" });
      const services = await servicesCollection.countDocuments({ technicianEmail: req.user.email });
      const active = user.plan === "pro" && user.subscriptionStatus === "active";
      return res.json({ plan: active ? "pro" : "free", subscriptionStatus: user.subscriptionStatus || "none", services, limit: active ? null : 3, verifiedPro: active, renewsAt: user.proCurrentPeriodEnd || null });
    } catch (error) { console.error("Pro status error", error); return res.status(500).json({ message: "Unable to load plan" }); }
  });

  router.post("/technician/pro/checkout", async (req, res) => {
    try {
      if (!priceId?.startsWith("price_") || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
        return res.status(503).json({ message: "Stripe Pro plan is not configured" });
      }
      const user = await getUser(req);
      if (!user) return res.status(404).json({ message: "Technician not found" });
      if (user.plan === "pro" && user.subscriptionStatus === "active") return res.status(409).json({ message: "Your Pro subscription is active" });
      if (user.stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId).catch(() => null);
        if (sub && ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(sub.status)) {
          return res.status(409).json({ message: "You already have a subscription. Use Manage Billing." });
        }
      }
      if (user.proCheckoutSessionId) {
        const previous = await stripe.checkout.sessions.retrieve(user.proCheckoutSessionId).catch(() => null);
        if (previous?.status === "open" && previous.url) return res.json({ url: previous.url });
        if (previous?.status === "complete") return res.status(409).json({ message: "Checkout already completed. Refresh after Stripe confirms your subscription." });
      }
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active || !price.recurring || price.currency !== "usd") {
        return res.status(503).json({ message: "Configure an active recurring USD price in Stripe" });
      }
      // A short atomic lock blocks simultaneous checkout creation.
      const lockSince = new Date(Date.now() - 5 * 60 * 1000);
      const locked = await usersCollection.findOneAndUpdate(
        { _id: user._id, $or: [{ proCheckoutLockAt: { $exists: false } }, { proCheckoutLockAt: { $lt: lockSince } }] },
        { $set: { proCheckoutLockAt: new Date() } }, { returnDocument: "after" }
      );
      if (!locked) return res.status(409).json({ message: "Checkout is already being prepared" });
      try {
        const stripeCustomer = user.stripeCustomerId || (await stripe.customers.create(
          { email: user.email, name: user.name, metadata: { fixmateUserId: String(user.id || user._id) } },
          { idempotencyKey: `fixmate-pro-customer-${String(user._id)}` }
        )).id;
        await usersCollection.updateOne({ _id: user._id }, { $set: { stripeCustomerId: stripeCustomer } });
        const session = await stripe.checkout.sessions.create({
          mode: "subscription", customer: stripeCustomer,
          line_items: [{ price: priceId, quantity: 1 }],
          client_reference_id: String(user.id || user._id),
          metadata: { fixmateUserId: String(user.id || user._id), technicianEmail: user.email },
          subscription_data: { metadata: { fixmateUserId: String(user.id || user._id), technicianEmail: user.email, fixmatePlan: "pro" } },
          success_url: `${appUrl}/dashboard/technician/pro?checkout=success`,
          cancel_url: `${appUrl}/dashboard/technician/pro?checkout=cancel`,
        }, { idempotencyKey: `fixmate-pro-checkout-${String(user._id)}-${Math.floor(Date.now() / 300000)}` });
        if (!session.url) throw new Error("Stripe returned no Checkout URL");
        await usersCollection.updateOne({ _id: user._id }, { $set: { proCheckoutSessionId: session.id } });
        return res.json({ url: session.url });
      } finally {
        await usersCollection.updateOne({ _id: user._id }, { $unset: { proCheckoutLockAt: "" } });
      }
    } catch (error) { console.error("Pro checkout error", error); return res.status(500).json({ message: "Unable to create Pro checkout" }); }
  });

  router.post("/technician/pro/portal", async (req, res) => {
    try {
      const user = await getUser(req);
      if (!user?.stripeCustomerId) return res.status(404).json({ message: "No Stripe billing account found" });
      const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${appUrl}/dashboard/technician/pro` });
      return res.json({ url: session.url });
    } catch (error) { console.error("Pro portal error", error); return res.status(500).json({ message: "Unable to open billing portal" }); }
  });
  return router;
}
