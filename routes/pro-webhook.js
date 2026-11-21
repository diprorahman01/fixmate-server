import { Router } from "express";
import Stripe from "stripe";

/** Signed Stripe events only. Mount with express.raw BEFORE express.json(). */
export function createProWebhookRouter({ usersCollection, paymentsCollection }) {
  const router = Router();
  const secret = process.env.STRIPE_PRO_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) {
    router.post("/", (_req, res) => res.status(503).send("Pro webhook not configured"));
    return router;
  }
  const stripe = new Stripe(key);

  const idOf = (value) => typeof value === "string" ? value : value?.id;
  const subscriptionFromInvoice = (invoice) =>
    idOf(invoice.parent?.subscription_details?.subscription) || idOf(invoice.subscription);
  const activeStatus = (status) => status === "active";

  async function syncSubscription(subscriptionId) {
    if (!subscriptionId) return null;
    // Retrieve CURRENT Stripe state so out-of-order events don't restore canceled subscriptions.
    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId = idOf(sub.customer);
    const email = sub.metadata?.technicianEmail;
    if (!customerId || !email || sub.metadata?.fixmatePlan !== "pro") return null;
    const user = await usersCollection.findOne({ email, role: "technician", stripeCustomerId: customerId });
    if (!user || String(user.id || user._id) !== sub.metadata.fixmateUserId) return null;
    const isActive = activeStatus(sub.status);
    const periodEnd = sub.items?.data?.[0]?.current_period_end || sub.current_period_end;
    await usersCollection.updateOne({ _id: user._id, stripeCustomerId: customerId }, { $set: {
      plan: isActive ? "pro" : "free", subscriptionStatus: sub.status,
      stripeSubscriptionId: sub.id, proCurrentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      updatedAt: new Date(),
    }});
    return { user, sub };
  }

  router.post("/", async (req, res) => {
    let event;
    try {
      if (!Buffer.isBuffer(req.body) || !req.headers["stripe-signature"]) return res.status(400).send("Expected signed raw Stripe body");
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
    } catch (error) { return res.status(400).send("Invalid Stripe signature"); }
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session.mode === "subscription" && session.subscription) {
          await syncSubscription(idOf(session.subscription));
        }
      } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
        await syncSubscription(event.data.object.id);
      } else if (event.type === "invoice.paid") {
        const invoice = event.data.object;
        const subscriptionId = subscriptionFromInvoice(invoice);
        if (subscriptionId && invoice.amount_paid > 0 && invoice.currency === "usd") {
          const info = await syncSubscription(subscriptionId);
          if (info && info.sub.status === "active") {
            const invoiceId = invoice.id;
            // Required unique fields match the existing payments collection indexes.
            // Pro payments are distinguishable from repair payments by type and synthetic bookingId.
            const payment = {
              type: "pro_subscription", bookingId: `pro:${invoiceId}`,
              customerEmail: info.user.email, customerName: info.user.name,
              technicianEmail: info.user.email, technicianName: info.user.name,
              serviceTitle: "FixMate Verified Pro Subscription",
              amount: invoice.amount_paid / 100, currency: invoice.currency,
              transactionId: `pro:${invoiceId}`, sessionId: `pro:${invoiceId}`,
              stripeInvoiceId: invoiceId, stripeSubscriptionId: subscriptionId,
              paidAt: new Date((invoice.status_transitions?.paid_at || event.created) * 1000),
            };
            await paymentsCollection.updateOne({ bookingId: payment.bookingId }, { $setOnInsert: payment }, { upsert: true });
          }
        }
      } else if (event.type === "invoice.payment_failed") {
        const subscriptionId = subscriptionFromInvoice(event.data.object);
        if (subscriptionId) await syncSubscription(subscriptionId);
      }
      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("FixMate Pro webhook processing failed", error);
      return res.status(500).send("Retry webhook later");
    }
  });
  return router;
}
