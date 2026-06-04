import { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import axios from 'axios';
import Shipment from '../models/Shipment';
import logger from '../utils/logger';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-04-10' as any,
});

// ── Stripe ─────────────────────────────────────────────────────────────────

export const createStripeIntent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { shipmentId } = req.body;

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    const amountCents = Math.round(shipment.payment.amount * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: (shipment.payment.currency || 'CAD').toLowerCase(),
      metadata: {
        shipmentId: shipment._id.toString(),
        shipmentNumber: shipment.shipmentNumber,
      },
      automatic_payment_methods: { enabled: true },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      intentId: paymentIntent.id,
    });
  } catch (error) {
    next(error);
  }
};

export const stripeWebhook = async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err: any) {
    logger.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as Stripe.PaymentIntent;
    const shipmentId = pi.metadata.shipmentId;

    if (shipmentId) {
      await Shipment.findByIdAndUpdate(shipmentId, {
        'payment.status': 'completed',
        'payment.transactionId': pi.id,
        'payment.method': 'stripe',
        'payment.paidAt': new Date(),
        status: 'paid',
      });
      logger.info(`Stripe payment confirmed for shipment ${shipmentId}`);
    }
  }

  res.json({ received: true });
};

// ── PayPal ──────────────────────────────────────────────────────────────────

const getPayPalAccessToken = async (): Promise<string> => {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE || 'sandbox';
  const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  const response = await axios.post(
    `${base}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      auth: { username: clientId || '', password: secret || '' },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return response.data.access_token;
};

export const createPayPalOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { shipmentId } = req.body;

    const shipment = await Shipment.findById(shipmentId);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const token = await getPayPalAccessToken();

    const order = await axios.post(
      `${base}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: shipment.shipmentNumber,
          amount: {
            currency_code: shipment.payment.currency || 'CAD',
            value: shipment.payment.amount.toFixed(2),
          },
          description: `Pilot Courier — ${shipment.shipmentNumber}`,
        }],
        application_context: {
          return_url: `${process.env.FRONTEND_URL}/booking/success?shipmentId=${shipmentId}`,
          cancel_url: `${process.env.FRONTEND_URL}/booking/cancel?shipmentId=${shipmentId}`,
        },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    res.json({ success: true, orderId: order.data.id, links: order.data.links });
  } catch (error) {
    next(error);
  }
};

export const capturePayPalOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orderId, shipmentId } = req.body;

    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const base = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const token = await getPayPalAccessToken();

    const capture = await axios.post(
      `${base}/v2/checkout/orders/${orderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    if (capture.data.status === 'COMPLETED') {
      await Shipment.findByIdAndUpdate(shipmentId, {
        'payment.status': 'completed',
        'payment.transactionId': orderId,
        'payment.method': 'paypal',
        'payment.paidAt': new Date(),
        status: 'paid',
      });

      return res.json({ success: true, message: 'Payment captured.' });
    }

    res.status(400).json({ success: false, message: 'Payment capture failed.' });
  } catch (error) {
    next(error);
  }
};
