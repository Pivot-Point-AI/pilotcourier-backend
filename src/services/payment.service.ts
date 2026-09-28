import Stripe from 'stripe';
import Shipment, { IShipment } from '../models/Shipment';
import { requestError } from '../utils/shipment-access';
import logger from '../utils/logger';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder', { apiVersion: '2024-04-10' as any });
// Stripe amounts use currency minor units, including its ISK/UGX compatibility rules.
// https://docs.stripe.com/currencies
export function toMinorUnits(amount: number, currency = 'CAD'): number {
  const code = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(amount) || amount <= 0) {
    throw requestError(400, 'Invalid payment amount or currency.');
  }
  const wholeOnly = ['ISK', 'UGX'].includes(code);
  const digits = wholeOnly ? 2 : (new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2);
  const units = Math.round(amount * 10 ** digits);
  if (!Number.isSafeInteger(units) || Math.abs(units / 10 ** digits - amount) > 1e-8 || (wholeOnly && !Number.isInteger(amount))) {
    throw requestError(400, 'Invalid payment amount for this currency.');
  }
  return units;
}
export function paypalAmount(amount: number, currency: string): string {
  const digits = ['HUF', 'JPY', 'TWD'].includes(currency.toUpperCase()) ? 0 : 2;
  if (!Number.isFinite(amount) || amount <= 0 || Number(amount.toFixed(digits)) !== amount) throw requestError(400, 'Invalid PayPal amount for this currency.');
  return amount.toFixed(digits);
}
export function requirePayable(shipment: IShipment) {
  if (!shipment.payment.priceVerified) throw requestError(409, 'Please obtain a fresh quote and create a new booking before payment.');
  if (shipment.status !== 'pending_payment' || shipment.payment.status !== 'pending') throw requestError(409, 'Shipment is not awaiting payment.');
  toMinorUnits(shipment.payment.amount, shipment.payment.currency);
}
export function checkStripeIntent(pi: Stripe.PaymentIntent, shipment: IShipment): { ok: boolean } {
  return { ok: !!shipment.payment.priceVerified && pi.id === shipment.payment.stripeIntentId &&
    pi.metadata?.shipmentId === String(shipment._id) && pi.metadata?.userId === String(shipment.userId) &&
    pi.status === 'succeeded' && pi.currency === shipment.payment.currency.toLowerCase() &&
    pi.amount === toMinorUnits(shipment.payment.amount, shipment.payment.currency) && pi.amount_received === pi.amount };
}
export function checkPayPalCapture(order: any, shipment: IShipment): { ok: boolean } {
  const units = order?.purchase_units;
  const unit = units?.[0];
  const captures = unit?.payments?.captures;
  const capture = captures?.[0];
  return { ok: !!shipment.payment.priceVerified && order?.id === shipment.payment.paypalOrderId &&
    units?.length === 1 && unit.custom_id === String(shipment._id) && unit.reference_id === shipment.shipmentNumber &&
    order.status === 'COMPLETED' && captures?.length === 1 && capture.status === 'COMPLETED' &&
    capture.amount?.currency_code === shipment.payment.currency &&
    /^\d+(?:\.\d{1,2})?$/.test(capture.amount?.value || '') &&
    Number(capture.amount.value) === shipment.payment.amount };
}
// Claim completion once in MongoDB, shared by client confirmation and webhooks.
// An uncertain carrier response is left for reconciliation, never blindly rebooked.
export async function settlePayment(shipment: IShipment, method: 'stripe' | 'paypal', transactionId: string): Promise<IShipment> {
  const binding = method === 'stripe' ? 'stripeIntentId' : 'paypalOrderId';
  if (!shipment.payment.priceVerified || shipment.payment[binding] !== transactionId) throw requestError(400, 'Payment does not belong to this shipment.');
  const claimed = await Shipment.findOneAndUpdate({
    _id: shipment._id, status: 'pending_payment', 'payment.status': 'pending',
    'payment.priceVerified': true, [`payment.${binding}`]: transactionId,
    'payment.amount': shipment.payment.amount, 'payment.currency': shipment.payment.currency,
  }, { $set: { status: 'paid', 'payment.status': 'completed', 'payment.method': method,
    'payment.transactionId': transactionId, 'payment.paidAt': new Date() },
    $push: { statusHistory: { status: 'paid', timestamp: new Date(), note: 'Provider payment verified' } },
  }, { new: true });
  if (!claimed) {
    const current = await Shipment.findById(shipment._id);
    if (current?.payment.status === 'completed' && current.payment.transactionId === transactionId) return current;
    throw requestError(409, 'Shipment payment state has changed.');
  }
  const { generateLabelForShipment } = await import('../controllers/shipment.controller');
  await generateLabelForShipment(claimed);
  await claimed.save();
  // Email failure must not undo a verified payment or trigger a second booking.
  try {
    const emailService = (await import('./email.service')).default;
    const email = claimed.guestEmail || claimed.recipient.email;
    if (email) await emailService.sendBookingConfirmation(email, claimed, claimed.guestPhone);
  } catch (error) { logger.warn('Booking confirmation email failed', error); }
  return claimed;
}
