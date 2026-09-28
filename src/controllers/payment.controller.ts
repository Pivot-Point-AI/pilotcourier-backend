import { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import axios from 'axios';
import Shipment from '../models/Shipment';
import { ownedShipment, requestError } from '../utils/shipment-access';
import { stripe, toMinorUnits, paypalAmount, requirePayable, checkStripeIntent, checkPayPalCapture, settlePayment } from '../services/payment.service';
import logger from '../utils/logger';

async function reserveMethod(shipment: any, method: 'stripe' | 'paypal') {
  requirePayable(shipment);
  const reserved = await Shipment.findOneAndUpdate({ _id: shipment._id, status: 'pending_payment',
    'payment.status': 'pending', $or: [{ 'payment.method': { $exists: false } }, { 'payment.method': method }],
  }, { $set: { 'payment.method': method } }, { new: true });
  if (!reserved) throw requestError(409, 'This booking already has a different payment method or is no longer payable.');
  return reserved;
}
export const createStripeIntent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shipment = await reserveMethod(await ownedShipment(req, req.body.shipmentId), 'stripe');
    const pi = shipment.payment.stripeIntentId
      ? await stripe.paymentIntents.retrieve(shipment.payment.stripeIntentId)
      : await stripe.paymentIntents.create({
        amount: toMinorUnits(shipment.payment.amount, shipment.payment.currency), currency: shipment.payment.currency.toLowerCase(),
        metadata: { shipmentId: String(shipment._id), userId: String(shipment.userId), shipmentNumber: shipment.shipmentNumber },
        automatic_payment_methods: { enabled: true },
      }, { idempotencyKey: `shipment-${shipment._id}-stripe` });
    const bound = await Shipment.updateOne({ _id: shipment._id, status: 'pending_payment', 'payment.status': 'pending' }, { $set: { 'payment.stripeIntentId': pi.id } });
    if (bound.matchedCount !== 1) throw requestError(409, 'Shipment is no longer awaiting payment.');
    res.json({ success: true, clientSecret: pi.client_secret, intentId: pi.id, amount: shipment.payment.amount, currency: shipment.payment.currency });
  } catch (error) { next(error); }
};
export const stripeWebhook = async (req: Request, res: Response) => {
  let event: Stripe.Event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, process.env.STRIPE_WEBHOOK_SECRET || ''); }
  catch { return res.status(400).json({ success: false, message: 'Invalid webhook signature.' }); }
  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (/^[a-f\d]{24}$/i.test(pi.metadata?.shipmentId || '')) {
        const shipment = await Shipment.findById(pi.metadata.shipmentId);
        if (shipment) {
          if (!checkStripeIntent(pi, shipment).ok) throw requestError(400, 'Payment verification failed.');
          await settlePayment(shipment, 'stripe', pi.id);
        }
      }
    }
    return res.json({ received: true });
  } catch (error) {
    logger.error('Webhook processing failed', error);
    return res.status(500).json({ success: false, message: 'Webhook processing failed.' });
  }
};
const paypalBase = () => process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
async function paypalHeaders() {
  const token = await axios.post(`${paypalBase()}/v1/oauth2/token`, 'grant_type=client_credentials', {
    auth: { username: process.env.PAYPAL_CLIENT_ID || '', password: process.env.PAYPAL_CLIENT_SECRET || '' },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000,
  });
  return { Authorization: `Bearer ${token.data.access_token}`, 'Content-Type': 'application/json' };
}
export const createPayPalOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shipment = await reserveMethod(await ownedShipment(req, req.body.shipmentId), 'paypal');
    const headers = await paypalHeaders();
    const order = shipment.payment.paypalOrderId
      ? await axios.get(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(shipment.payment.paypalOrderId)}`, { headers, timeout: 15000 })
      : await axios.post(`${paypalBase()}/v2/checkout/orders`, {
        intent: 'CAPTURE', purchase_units: [{ reference_id: shipment.shipmentNumber, custom_id: String(shipment._id),
          amount: { currency_code: shipment.payment.currency, value: paypalAmount(shipment.payment.amount, shipment.payment.currency) },
          description: `Pilot Courier ${shipment.shipmentNumber}` }],
      }, { headers: { ...headers, 'PayPal-Request-Id': `pc-${shipment._id}` }, timeout: 15000 });
    const bound = await Shipment.updateOne({ _id: shipment._id, status: 'pending_payment', 'payment.status': 'pending' }, { $set: { 'payment.paypalOrderId': order.data.id } });
    if (bound.matchedCount !== 1) throw requestError(409, 'Shipment is no longer awaiting payment.');
    res.json({ success: true, orderId: order.data.id, links: order.data.links });
  } catch (error) { next(error); }
};
export const capturePayPalOrder = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shipment = await ownedShipment(req, req.body.shipmentId);
    const { orderId } = req.body;
    if (typeof orderId !== 'string' || orderId !== shipment.payment.paypalOrderId) throw requestError(400, 'Payment does not belong to this shipment.');
    if (shipment.payment.status !== 'completed') requirePayable(shipment);
    const headers = await paypalHeaders();
    const url = `${paypalBase()}/v2/checkout/orders/${encodeURIComponent(orderId)}`;
    let { data } = await axios.get(url, { headers, timeout: 15000 });
    const unit = data?.purchase_units?.[0];
    if (data?.id !== orderId || data.purchase_units?.length !== 1 || unit?.custom_id !== String(shipment._id) ||
      unit?.reference_id !== shipment.shipmentNumber || unit?.amount?.currency_code !== shipment.payment.currency ||
      Number(unit?.amount?.value) !== shipment.payment.amount) throw requestError(400, 'Payment verification failed.');
    if (data.status !== 'COMPLETED') {
      if (data.status !== 'APPROVED') throw requestError(400, 'PayPal payment has not been approved.');
      ({ data } = await axios.post(`${url}/capture`, {}, { headers: { ...headers, 'PayPal-Request-Id': `capture-${shipment._id}` }, timeout: 15000 }));
    }
    if (!checkPayPalCapture(data, shipment).ok) throw requestError(400, 'Payment verification failed.');
    await settlePayment(shipment, 'paypal', orderId);
    res.json({ success: true, message: 'Payment verified.' });
  } catch (error) { next(error); }
};
