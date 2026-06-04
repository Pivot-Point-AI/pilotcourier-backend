import { Router } from 'express';
import {
  register, login, getMe, updateProfile, updateFullProfile,
  addSavedAddress, deleteSavedAddress,
  getPackages, addPackage, deletePackage,
  getProducts, addProduct, deleteProduct,
  getTickets, createTicket,
} from '../controllers/auth.controller';
import { getRates, bookShipment, confirmPayment, trackShipment, cancelShipment, getMyShipments, downloadLabel } from '../controllers/shipment.controller';
import { createStripeIntent, stripeWebhook, createPayPalOrder, capturePayPalOrder } from '../controllers/payment.controller';
import { getAllShipments, getDashboardStats, updateShipmentStatus, overridePrice, getAllUsers } from '../controllers/admin.controller';
import { authenticate, optionalAuth, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/register', register);
router.post('/auth/login', login);
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

// ── Shipments ─────────────────────────────────────────────────────────────────
router.post('/shipments/rates', getRates);
router.post('/shipments/book', optionalAuth, bookShipment);
router.post('/shipments/:id/confirm-payment', optionalAuth, confirmPayment);
router.get('/shipments/track/:trackingNumber', trackShipment);
router.post('/shipments/:id/cancel', optionalAuth, cancelShipment);
router.get('/shipments/my', authenticate, getMyShipments);
router.get('/shipments/:id/label', optionalAuth, downloadLabel);

// ── Payments ──────────────────────────────────────────────────────────────────
router.post('/payments/stripe/intent', optionalAuth, createStripeIntent);
router.post('/payments/stripe/webhook', stripeWebhook);
router.post('/payments/paypal/order', optionalAuth, createPayPalOrder);
router.post('/payments/paypal/capture', optionalAuth, capturePayPalOrder);

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get('/admin/dashboard', authenticate, requireAdmin, getDashboardStats);
router.get('/admin/shipments', authenticate, requireAdmin, getAllShipments);
router.patch('/admin/shipments/:id/status', authenticate, requireAdmin, updateShipmentStatus);
router.patch('/admin/shipments/:id/price', authenticate, requireAdmin, overridePrice);
router.get('/admin/users', authenticate, requireAdmin, getAllUsers);

// ── Geo lookups (proxy to netParcel) ─────────────────────────────────────────
router.get('/geo/postal', async (req, res) => {
  const { country, postal } = req.query as { country: string; postal: string };
  if (!country || !postal) return res.status(400).json({ error: 'country and postal required' });
  try {
    const postalClean = postal.trim().replace(/\s+/g, '').toUpperCase();
    // For CA use the FSA (first 3 chars) — zippopotam.us has full CA FSA coverage
    const lookupCode = country.toUpperCase() === 'CA' ? postalClean.slice(0, 3) : postalClean;
    const r = await fetch(`https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(lookupCode)}`);
    if (!r.ok) return res.json({ city: '', province: '' });
    const data = await r.json() as any;
    const place = data.places?.[0];
    if (!place) return res.json({ city: '', province: '' });
    const rawCity: string = place['place name'] || '';
    const city = rawCity.replace(/\s*\(.*?\)\s*/g, '').trim();
    res.json({
      city,
      province: place['state abbreviation'] || place['state'],
    });
  } catch {
    res.json({ city: '', province: '' });
  }
});

// Country ISO code → full name map for countriesnow API
const COUNTRY_NAMES: Record<string, string> = {
  CA: 'Canada', US: 'United States', GB: 'United Kingdom', AU: 'Australia',
  DE: 'Germany', FR: 'France', IN: 'India', PK: 'Pakistan', CN: 'China',
  MX: 'Mexico', JP: 'Japan', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
  NL: 'Netherlands', IT: 'Italy', ES: 'Spain', BR: 'Brazil', ZA: 'South Africa',
  SG: 'Singapore', HK: 'Hong Kong',
};

router.get('/geo/provinces', async (req, res) => {
  const { country } = req.query as { country: string };
  if (!country) return res.status(400).json({ error: 'country required' });
  const countryName = COUNTRY_NAMES[country.toUpperCase()];
  if (!countryName) return res.json([]);
  try {
    const r = await fetch('https://countriesnow.space/api/v0.1/countries/states', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country: countryName }),
    });
    const data = await r.json() as any;
    const states: { name: string; state_code: string }[] = data?.data?.states || [];
    res.json(states.map(s => ({ label: s.name, value: s.state_code || s.name })));
  } catch {
    res.json([]);
  }
});

router.get('/geo/cities', async (req, res) => {
  const { country = 'CA', q = '' } = req.query as { country?: string; q?: string };
  const countryName = COUNTRY_NAMES[(country as string).toUpperCase()] || 'Canada';
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
