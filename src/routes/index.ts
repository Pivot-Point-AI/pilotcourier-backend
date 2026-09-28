import subdivisions from '../data/subdivisions.json';
import { downloadInvoice } from '../controllers/invoice.controller';
import { Router } from 'express';
import { getPostal } from '../controllers/geo.controller';
import {
  register, login, getMe, updateProfile, updateFullProfile,
  forgotPassword, resetPassword,
  addSavedAddress, deleteSavedAddress,
  getPackages, addPackage, deletePackage,
  getProducts, addProduct, deleteProduct,
  getTickets, createTicket,
  getSavedQuotes, deleteSavedQuote,
} from '../controllers/auth.controller';
import { getRates, bookShipment, confirmPayment, trackShipment, cancelShipment, getMyShipments, downloadLabel } from '../controllers/shipment.controller';
import { createStripeIntent, stripeWebhook, createPayPalOrder, capturePayPalOrder } from '../controllers/payment.controller';
import { getAllShipments, getDashboardStats, updateShipmentStatus, overridePrice, getAllUsers } from '../controllers/admin.controller';
import { authenticate, optionalAuth, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/register', register);
router.post('/auth/login', login);
router.post('/auth/forgot-password', forgotPassword);
router.post('/auth/reset-password', resetPassword);
router.get('/auth/me', authenticate, getMe);
router.patch('/auth/profile', authenticate, updateProfile);
router.patch('/auth/profile/full', authenticate, updateFullProfile);
router.post('/auth/addresses', authenticate, addSavedAddress);
router.delete('/auth/addresses/:addressId', authenticate, deleteSavedAddress);

// ── Saved Packages ────────────────────────────────────────────────────────────
router.get('/auth/packages', authenticate, getPackages);
router.post('/auth/packages', authenticate, addPackage);
router.delete('/auth/packages/:packageId', authenticate, deletePackage);

// ── Saved Products ────────────────────────────────────────────────────────────
router.get('/auth/products', authenticate, getProducts);
router.post('/auth/products', authenticate, addProduct);
router.delete('/auth/products/:productId', authenticate, deleteProduct);

// ── Tickets ───────────────────────────────────────────────────────────────────
router.get('/auth/tickets', authenticate, getTickets);
router.post('/auth/tickets', authenticate, createTicket);

// ── Saved Quotes ──────────────────────────────────────────────────────────────
router.get('/auth/quotes', authenticate, getSavedQuotes);
router.delete('/auth/quotes/:quoteId', authenticate, deleteSavedQuote);

// ── Shipments ─────────────────────────────────────────────────────────────────
router.post('/shipments/rates', optionalAuth, getRates);
router.post('/shipments/book', authenticate, bookShipment);
router.post('/shipments/:id/confirm-payment', authenticate, confirmPayment);
router.get('/shipments/track/:trackingNumber', trackShipment);
router.post('/shipments/:id/cancel', authenticate, cancelShipment);
router.get('/shipments/my', authenticate, getMyShipments);
router.get('/shipments/:id/invoice', authenticate, downloadInvoice);
router.get('/shipments/:id/label', authenticate, downloadLabel);

// ── Payments ──────────────────────────────────────────────────────────────────
router.post('/payments/stripe/intent', authenticate, createStripeIntent);
router.post('/payments/stripe/webhook', stripeWebhook);
router.post('/payments/paypal/order', authenticate, createPayPalOrder);
router.post('/payments/paypal/capture', authenticate, capturePayPalOrder);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/dashboard', authenticate, requireAdmin, getDashboardStats);
router.get('/admin/shipments', authenticate, requireAdmin, getAllShipments);
router.patch('/admin/shipments/:id/status', authenticate, requireAdmin, updateShipmentStatus);
router.patch('/admin/shipments/:id/price', authenticate, requireAdmin, overridePrice);
router.get('/admin/users', authenticate, requireAdmin, getAllUsers);

// ── Geo lookups (proxy to netParcel) ─────────────────────────────────────────
// Exact lookup first; Canadian FSA fallback fills gaps in provider coverage.
router.get('/geo/postal', getPostal);

// Country ISO code → full name map for countriesnow API
const COUNTRY_NAMES: Record<string, string> = Object.fromEntries(subdivisions.map(c => [c.code, c.name]));

router.get('/geo/provinces', (req, res) => {
  if (typeof req.query.country !== 'string' || !/^[A-Za-z]{2}$/.test(req.query.country)) {
    return res.status(400).json({ error: 'Valid country required' });
  }
  const country = req.query.country.toUpperCase();
  const entry = subdivisions.find(c => c.code === country);
  if (!entry) return res.status(400).json({ error: 'Unsupported country' });
  return res.json(entry.states.map(s => ({ label: s.name, value: s.state_code?.replace(new RegExp('^' + country + '-'), '') || s.name })));
});

router.get('/geo/cities', async (req, res) => {
  const { country = 'CA', q = '' } = req.query as { country?: string; q?: string };
  if (typeof country !== 'string' || typeof q !== 'string') return res.status(400).json({ error: 'Invalid query' });
  const countryName = COUNTRY_NAMES[country.toUpperCase()];
  if (!countryName) return res.json([]);
  try {
    const r = await fetch('https://countriesnow.space/api/v0.1/countries/cities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: countryName }),
    });
    const data = await r.json() as any;
    const cities: string[] = data?.data || [];
    const filtered = q
      ? cities.filter((c: string) => c.toLowerCase().startsWith((q as string).toLowerCase())).slice(0, 50)
      : cities.slice(0, 50);
    res.json(filtered);
  } catch {
    res.json([]);
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Pilot Courier API', timestamp: new Date() }));

export default router;