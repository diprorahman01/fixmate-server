
import { Router } from "express";
import { ObjectId } from "mongodb";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";

// ==========================================
// FIXMATE STRIPE PAYMENT MANAGEMENT
// ==========================================

const isValidId = (id) =>
  typeof id === "string" &&
  /^[0-9a-fA-F]{24}$/.test(id);

const formatPayment = (payment) => ({
  ...payment,
  _id: payment._id.toString(),
});

// ==========================================
// STRIPE CONFIGURATION
// ==========================================

const stripeKey = process.env.STRIPE_SECRET_KEY;

if (!stripeKey?.startsWith("sk_test_")) {
  throw new Error(
    "STRIPE_SECRET_KEY must be a Stripe test key"
  );
}

const stripe = new Stripe(stripeKey);

const CLIENT_URL = (
  process.env.CLIENT_URL ||
  "http://localhost:3000"
)
  .split(",")[0]
  .trim()
  .replace(/\/$/, "");

const CURRENCY = "usd";

// ==========================================
// DATABASE INDEXES
// ==========================================

export async function createPaymentIndexes(
  paymentsCollection
) {
  // Only one payment document per booking.
  await paymentsCollection.createIndex(
    { bookingId: 1 },
    {
      unique: true,
      name: "unique_payment_per_booking",
    }
  );

  // Stripe transaction IDs must be unique.
  await paymentsCollection.createIndex(
    { transactionId: 1 },
    {
      unique: true,
      name: "unique_stripe_transaction",
    }
  );

  // Checkout session IDs must be unique.
  await paymentsCollection.createIndex(
    { sessionId: 1 },
    {
      unique: true,
      name: "unique_checkout_session",
    }
  );

  await paymentsCollection.createIndex({
    customerEmail: 1,
    paidAt: -1,
  });
}

// ==========================================
// CREATE PAYMENT ROUTER
// ==========================================

export function createPaymentRouter({
  bookingsCollection,
  paymentsCollection,
  verifyToken,
  verifyCustomer,
  verifyAdmin,
}) {
  const router = Router();

  // JWT is required for every endpoint.
  router.use(verifyToken);

  // ========================================
  // FINALIZE A VERIFIED STRIPE PAYMENT
  // ========================================

  async function recordPaidSession(
    session,
    booking
  ) {
    const bookingId = booking._id.toString();

    // Stripe must confirm the payment.
    if (
      session.mode !== "payment" ||
      session.payment_status !== "paid"
    ) {
      throw new Error(
        "Stripe has not confirmed payment"
      );
    }

    // Never trust the amount from the client.
    const expectedAmount = Math.round(
      Number(booking.finalAmount) * 100
    );

    const amount = session.amount_total;

    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;

    // Verify all important payment details.
    if (
      !paymentIntentId ||
      !Number.isSafeInteger(expectedAmount) ||
      session.metadata?.bookingId !== bookingId ||
      session.metadata?.customerEmail !==
        booking.customerEmail ||
      session.client_reference_id !== bookingId ||
      session.currency !== CURRENCY ||
      amount !== expectedAmount ||
      booking.checkoutSessionId !== session.id
    ) {
      throw new Error(
        "Stripe payment details do not match booking"
      );
    }

    const now = new Date();

    const payment = {
      bookingId,
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      technicianName: booking.technicianName,
      technicianEmail: booking.technicianEmail,
      serviceTitle: booking.serviceTitle,
      amount: amount / 100,
      currency: CURRENCY,
      transactionId: paymentIntentId,
      sessionId: session.id,
      paidAt: now,
    };

    // ======================================
    // PREVENT DUPLICATE PAYMENT RECORDS
    // ======================================
    //
    // If two verification requests arrive
    // simultaneously, MongoDB's unique
    // indexes allow only one payment record.
    // ======================================

    let newlyRecorded = false;

    try {
      const result =
        await paymentsCollection.updateOne(
          { bookingId },
          {
            $setOnInsert: payment,
          },
          {
            upsert: true,
          }
        );

      newlyRecorded =
        result.upsertedCount === 1;
    } catch (error) {
      // Another verification request may
      // have inserted the same payment.
      if (error.code !== 11000) {
        throw error;
      }
    }

    // Retrieve the saved record.
    const saved =
      await paymentsCollection.findOne({
        bookingId,
      });

    if (!saved) {
      throw new Error(
        "Payment record could not be found"
      );
    }

    // A repeated verification must refer
    // to exactly the same Stripe payment.
    if (
      saved.transactionId !== paymentIntentId ||
      saved.sessionId !== session.id ||
      saved.amount !== payment.amount ||
      saved.currency !== CURRENCY ||
      saved.customerEmail !== booking.customerEmail
    ) {
      throw new Error(
        "A different payment is already recorded"
      );
    }

    // ======================================
    // MARK BOOKING AS PAID
    // ======================================
    //
    // This update is safe to repeat.
    // If payment insertion worked but the
    // booking update previously failed,
    // another verification can repair it.
    // ======================================

    await bookingsCollection.updateOne(
      {
        _id: booking._id,
        status: "completed",
        checkoutSessionId: session.id,
      },
      {
        $set: {
          paymentStatus: "paid",
          paidAt: saved.paidAt,
          transactionId: saved.transactionId,
          updatedAt: now,
        },
      }
    );

    return {
      ...formatPayment(saved),
      newlyRecorded,
    };
  }

  // ========================================
  // CREATE STRIPE CHECKOUT SESSION
  // ========================================
  //
  // POST /api/payments/create-checkout-session
  // Body: { bookingId }
  // Customer only
  // ========================================

  router.post(
    "/payments/create-checkout-session",
    verifyCustomer,
    async (req, res) => {
      let lockedId = null;
      let lockToken = null;

      try {
        const { bookingId } = req.body ?? {};

        if (!isValidId(bookingId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid booking ID",
          });
        }

        // Load only this customer's booking.
        const booking =
          await bookingsCollection.findOne({
            _id: new ObjectId(bookingId),
            customerEmail: req.user.email,
          });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Booking not found",
          });
        }

        // Payment is allowed only after
        // the technician completes the job.
        if (booking.status !== "completed") {
          return res.status(409).send({
            success: false,
            message:
              "Payment is allowed after repair completion",
          });
        }

        if (booking.paymentStatus === "paid") {
          return res.status(409).send({
            success: false,
            message: "Booking is already paid",
          });
        }

        // Amount comes from MongoDB only.
        const amount = Math.round(
          Number(booking.finalAmount) * 100
        );

        if (
          !Number.isSafeInteger(amount) ||
          amount < 50 ||
          amount > 100000000
        ) {
          return res.status(400).send({
            success: false,
            message:
              "Invalid final amount for USD Checkout",
          });
        }

        // ==================================
        // CHECKOUT CREATION LOCK
        // ==================================

        lockToken = randomUUID();

        const now = new Date();

        const staleBefore = new Date(
          now.getTime() - 5 * 60 * 1000
        );

        const locked =
          await bookingsCollection.updateOne(
            {
              _id: booking._id,
              customerEmail: req.user.email,
              status: "completed",
              paymentStatus: "unpaid",
              $or: [
                {
                  checkoutLock: {
                    $exists: false,
                  },
                },
                {
                  checkoutLock: null,
                },
                {
                  checkoutLockedAt: {
                    $lt: staleBefore,
                  },
                },
              ],
            },
            {
              $set: {
                checkoutLock: lockToken,
                checkoutLockedAt: now,
              },
            }
          );

        if (!locked.matchedCount) {
          return res.status(409).send({
            success: false,
            message:
              "Checkout is being prepared. Try again shortly.",
          });
        }

        lockedId = booking._id;

        // Refresh after acquiring the lock.
        const currentBooking =
          await bookingsCollection.findOne({
            _id: booking._id,
            checkoutLock: lockToken,
          });

        if (!currentBooking) {
          throw new Error(
            "Could not load locked booking"
          );
        }

        // ==================================
        // REUSE EXISTING CHECKOUT
        // ==================================

        if (currentBooking.checkoutSessionId) {
          const previous =
            await stripe.checkout.sessions.retrieve(
              currentBooking.checkoutSessionId
            );

          if (previous.payment_status === "paid") {
            await recordPaidSession(
              previous,
              currentBooking
            );

            return res.status(409).send({
              success: false,
              message:
                "Payment already completed. Refresh My Bookings.",
            });
          }

          // Reuse an open session.
          if (
            previous.status === "open" &&
            previous.url
          ) {
            return res.send({
              success: true,
              url: previous.url,
            });
          }
        }

        // ==================================
        // CREATE NEW STRIPE CHECKOUT
        // ==================================

        const session =
          await stripe.checkout.sessions.create(
            {
              mode: "payment",

              payment_method_types: [
                "card",
              ],

              client_reference_id: bookingId,

              customer_email:
                currentBooking.customerEmail,

              line_items: [
                {
                  price_data: {
                    currency: CURRENCY,

                    product_data: {
                      name:
                        currentBooking.serviceTitle,
                    },

                    unit_amount: amount,
                  },

                  quantity: 1,
                },
              ],

              metadata: {
                bookingId,
                customerEmail:
                  currentBooking.customerEmail,
              },

              success_url:
                `${CLIENT_URL}/payment/success` +
                "?session_id={CHECKOUT_SESSION_ID}",

              cancel_url:
                `${CLIENT_URL}/payment/cancel`,
            },
            {
              idempotencyKey:
                `fixmate-${bookingId}-${lockToken}`,
            }
          );

        if (!session.url) {
          throw new Error(
            "Stripe did not return a Checkout URL"
          );
        }

        // ==================================
        // SAVE CHECKOUT SESSION
        // ==================================

        const savedSession =
          await bookingsCollection.updateOne(
            {
              _id: booking._id,
              checkoutLock: lockToken,
              paymentStatus: "unpaid",
            },
            {
              $set: {
                checkoutSessionId: session.id,
                checkoutCreatedAt: new Date(),
              },
            }
          );

        if (!savedSession.matchedCount) {
          throw new Error(
            "Could not save Stripe Checkout session"
          );
        }

        return res.send({
          success: true,
          url: session.url,
        });
      } catch (error) {
        console.error(
          "Checkout creation error:",
          error
        );

        return res.status(500).send({
          success: false,
          message:
            "Unable to create Stripe Checkout",
        });
      } finally {
        // Release only this request's lock.
        if (lockedId && lockToken) {
          try {
            await bookingsCollection.updateOne(
              {
                _id: lockedId,
                checkoutLock: lockToken,
              },
              {
                $unset: {
                  checkoutLock: "",
                  checkoutLockedAt: "",
                },
              }
            );
          } catch (error) {
            console.error(
              "Checkout lock cleanup error:",
              error
            );
          }
        }
      }
    }
  );

  // ========================================
  // VERIFY PAYMENT WITH STRIPE
  // ========================================
  //
  // GET /api/payments/verify?session_id=...
  // Customer only
  // ========================================

  router.get(
    "/payments/verify",
    verifyCustomer,
    async (req, res) => {
      try {
        const sessionId = req.query.session_id;

        if (
          typeof sessionId !== "string" ||
          !sessionId.startsWith("cs_test_")
        ) {
          return res.status(400).send({
            success: false,
            message:
              "Invalid Stripe session ID",
          });
        }

        // Retrieve payment status directly
        // from Stripe.
        const session =
          await stripe.checkout.sessions.retrieve(
            sessionId
          );

        const bookingId =
          session.metadata?.bookingId;

        if (!isValidId(bookingId)) {
          return res.status(400).send({
            success: false,
            message:
              "Invalid booking reference",
          });
        }

        // Check authenticated ownership.
        const booking =
          await bookingsCollection.findOne({
            _id: new ObjectId(bookingId),
            customerEmail: req.user.email,
            status: "completed",
          });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Booking not found",
          });
        }

        // Checkout must match this booking.
        if (
          booking.checkoutSessionId !==
          session.id
        ) {
          return res.status(403).send({
            success: false,
            message:
              "Checkout session does not match booking",
          });
        }

        // Never mark unpaid Stripe sessions
        // as paid.
        if (
          session.payment_status !== "paid"
        ) {
          return res.status(409).send({
            success: false,
            message:
              "Stripe has not confirmed payment yet",
          });
        }

        // Save once, update booking.
        const payment =
          await recordPaidSession(
            session,
            booking
          );

        return res.status(200).send({
          success: true,
          message:
            "Payment verified successfully",
          payment,
        });
      } catch (error) {
        console.error(
          "Payment verification error:",
          error
        );

        return res.status(500).send({
          success: false,
          message:
            "Payment verification failed",
        });
      }
    }
  );

  // ========================================
  // CUSTOMER PAYMENT HISTORY
  // ========================================
  //
  // GET /api/customer/payments
  // Customer only
  // ========================================

  router.get(
    "/customer/payments",
    verifyCustomer,
    async (req, res) => {
      try {
        const payments =
          await paymentsCollection
            .find({
              customerEmail: req.user.email,
            })
            .sort({
              paidAt: -1,
            })
            .toArray();

        return res.status(200).send(
          payments.map(formatPayment)
        );
      } catch (error) {
        console.error(
          "Customer payments error:",
          error
        );

        return res.status(500).send({
          success: false,
          message:
            "Unable to load payment history",
        });
      }
    }
  );

  // ========================================
  // ADMIN ALL TRANSACTIONS
  // ========================================
  //
  // GET /api/admin/transactions
  // Admin only
  // ========================================

  router.get(
    "/admin/transactions",
    verifyAdmin,
    async (req, res) => {
      try {
        const payments =
          await paymentsCollection
            .find({})
            .sort({
              paidAt: -1,
            })
            .toArray();

        const revenue = payments.reduce(
          (sum, payment) =>
            sum + Number(payment.amount),
          0
        );

        return res.status(200).send({
          totalRevenue:
            Math.round(revenue * 100) / 100,

          payments: payments.map(
            formatPayment
          ),
        });
      } catch (error) {
        console.error(
          "Admin transactions error:",
          error
        );

        return res.status(500).send({
          success: false,
          message:
            "Unable to load transactions",
        });
      }
    }
  );

  // ========================================
  // RETURN PAYMENT ROUTER
  // ========================================

  return router;
}
