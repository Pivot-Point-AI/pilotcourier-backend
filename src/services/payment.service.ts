import Stripe from 'stripe';
import { IShipment } from '../models/Shipment';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', {
  apiVersion: '2024-04-10' as any,
});

// CAD and USD are both charged in cents by Stripe and PayPal.
export const toMinorUnits = (amount: number): number => Math.round(Number(amount) * 100);

export type PaymentCheck =
  | { ok: true }
  | { ok: false; code: 'WRONG_SHIPMENT' | 'NOT_COMPLETED' | 'AMOUNT_MISMATCH'; reason: string };

// A PaymentIntent pays for a shipment only if our server created it for that
// shipment, it has succeeded, and the amount Stripe actually collected equals
// the server-side price stored on the shipment.
export const checkStripeIntent = (pi: Stripe.PaymentIntent, shipment: IShipment): PaymentCheck => {
  if (pi.metadata?.shipmentId !== String(shipment._id)) {
    return { ok: false, code: 'WRONG_SHIPMENT', reason: `PaymentIntent ${pi.id} was created for another shipment` };
  }
  if (pi.status !== 'succeeded') {
    return { ok: false, code: 'NOT_COMPLETED', reason: `PaymentIntent ${pi.id} status is ${pi.status}` };
  }
  const currency = (shipment.payment.currency || 'CAD').toLowerCase();
  const expected = toMinorUnits(shipment.payment.amount);
  if (pi.currency !== currency || pi.amount_received !== expected) {
    return {
      ok: false,
      code: 'AMOUNT_MISMATCH',
      reason: `PaymentIntent ${pi.id} collected ${pi.amount_received} ${pi.currency}, expected ${expected} ${currency}`,
    };
  }
  return { ok: true };
};

// Same rules for a PayPal v2 capture response: the order must be ours for this
// shipment and the captured amount must equal the server-side price.
export const checkPayPalCapture = (capture: any, shipment: IShipment): PaymentCheck => {
  const unit = capture?.purchase_units?.[0];
  if (unit?.reference_id !== shipment.shipmentNumber) {
    return { ok: false, code: 'WRONG_SHIPMENT', reason: `PayPal order ${capture?.id} was created for ${unit?.reference_id}` };
  }
  const captured = unit?.payments?.captures?.[0];
  if (capture?.status !== 'COMPLETED' || captured?.status !== 'COMPLETED') {
    return { ok: false, code: 'NOT_COMPLETED', reason: `PayPal order ${capture?.id} status is ${capture?.status}/${captured?.status}` };
  }
  const currency = shipment.payment.currency || 'CAD';
  const expected = toMinorUnits(shipment.payment.amount);
  const received = toMinorUnits(parseFloat(captured?.amount?.value));
  if (captured?.amount?.currency_code !== currency || received !== expected) {
    return {
      ok: false,
      code: 'AMOUNT_MISMATCH',
      reason: `PayPal order ${capture?.id} captured ${received} ${captured?.amount?.currency_code}, expected ${expected} ${currency}`,
    };
  }
  return { ok: true };
};
