import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Shipment, { IShipment } from '../models/Shipment';
import SavedQuote from '../models/SavedQuote';
import netparcelService, { CUSTOMS_EXPORT_REASONS, CUSTOMS_TAX_TYPES, DEFAULT_EXPORT_REASON, envelopePackage } from '../services/netparcel.service';
import emailService from '../services/email.service';
import logger from '../utils/logger';
import { tagRates, normalizeDeliveryDate } from '../utils/rate-display';
import { ownedShipment, requestError } from '../utils/shipment-access';
import { stripe, checkStripeIntent, settlePayment } from '../services/payment.service';
import { isPostalFormatValid } from '../utils/postal';

// Books the shipment with netParcel and attaches the returned label/tracking
// number to the shipment doc. Used both by confirmPayment (synchronous, client-
// initiated) and by the Stripe/PayPal webhooks as a safety net so a label still
// gets generated if the client never calls confirm-payment after paying.
// Does not save() — caller is responsible for persisting.
export const generateLabelForShipment = async (shipment: IShipment): Promise<boolean> => {
  try {
    const pd = shipment.pickupDetails;
    const ss = shipment.specialServices || {};
    const shipDate = pd?.pickupDate || new Date().toISOString().split('T')[0];

    const pickupBlock = pd?.method === 'schedule_pickup' ? {
      location: pd.location || 'Front Door',
      instructions: pd.instructions || '',
      ready_time: { ready_hour: pd.readyHour || '09', ready_min: pd.readyMin || '00' },
      close_time: { close_hour: pd.closeHour || '17', close_min: pd.closeMin || '00' },
    } : undefined;

    const refs = (shipment.references || []).map((r) => ({
      reference_name: r.referenceName,
      reference_value: r.referenceValue,
    }));
    // Customer references take priority over the optional internal order reference.
    if (refs.length < 3) refs.push({ reference_name: 'Order', reference_value: shipment.shipmentNumber });

    const shipPayload = {
      ship: {
        shipper_type: shipment.shipper.addressType || 'consumer',
        consignee_type: shipment.recipient.addressType || 'consumer',
        origin: {
          ...netparcelService.buildAddress(shipment.shipper),
          address_type: shipment.shipper.isResidential ? 'residential' : null,
        },
        destination: {
          ...netparcelService.buildAddress(shipment.recipient),
          address_type: shipment.recipient.isResidential ? 'residential' : null,
          email: shipment.recipient.email,
          send_email_confirmation: !!shipment.recipient.email && shipment.notifyRecipient !== false,
        },
        service: {
          service_code: parseInt(shipment.selectedRate.serviceCode, 10) || shipment.selectedRate.serviceCode,
          service_name: shipment.selectedRate.serviceName,
        },
        ship_date: shipDate,
        pick_up: pickupBlock,
        special_services: {
          saturday_delivery: ss.saturdayDelivery || false,
          signature_required: ss.signatureRequired || false,
          adult_signature: ss.adultSignature || false,
          hold_for_pickup: ss.holdForPickup || false,
          inside_pickup: ss.insidePickup || false,
          inside_delivery: ss.insideDelivery || false,
          tailgate_pickup: ss.tailgatePickup || false,
          tailgate_delivery: ss.tailgateDelivery || false,
        },
        packaging_information: netparcelService.buildPackagingInformation(shipment.parcels, shipment.packagingType),
        references: refs.slice(0, 3),
        generate_label: true,
        customs_invoice: shipment.shipmentType === 'international' && shipment.customsInvoice
          ? netparcelService.buildCustomsInvoice(shipment.customsInvoice)
          : undefined,
      },
    };

    const npShipment = await netparcelService.createShipment(shipPayload);

    shipment.netparcelOrderId = npShipment.order_id;
    shipment.trackingNumber = npShipment.master_tracking_num;
    shipment.labelUrl = npShipment.tracking_url;
    shipment.status = pickupBlock ? 'pickup_scheduled' : 'label_generated';

    const labelDoc = npShipment.documents?.find((d: any) => d.document_name === 'labels');
    if (labelDoc?.base64_encoded_string) {
      shipment.labelBase64 = labelDoc.base64_encoded_string;
    }
    return true;
  } catch (labelErr) {
    logger.warn(`Label generation failed for shipment ${shipment._id}, will need retry:`, labelErr);
    shipment.status = 'label_pending';
    return false;
  }
};

const QUOTE_VALIDITY_DAYS: Record<'quick' | 'detailed', number> = {
  quick: 15,
  detailed: 60,
};

const MARKUP_RATE = parseFloat(process.env.RATE_MARKUP_PERCENT || '15') / 100;
const applyMarkup = (price: number): number => parseFloat((price * (1 + MARKUP_RATE)).toFixed(2));

// Normalized fingerprint of the inputs that define a quote — used to dedupe identical
// re-quotes for the same user (same addresses/contact/package values) instead of
// saving a fresh record every time.
const SIGNATURE_FIELDS = [
  'originPostal', 'originCity', 'originProvince', 'originCountry', 'originResidential',
  'originName', 'originCompany', 'originStreet', 'originStreet2', 'originPhone', 'originEmail',
  'destinationPostal', 'destinationCity', 'destinationProvince', 'destinationCountry', 'destinationResidential',
  'destinationName', 'destinationCompany', 'destinationStreet', 'destinationStreet2', 'destinationPhone', 'destinationEmail',
  'weight', 'weightUnit', 'length', 'width', 'height', 'dimensionUnit',
  'description', 'insuranceAmount', 'specialHandling', 'packagingType', 'packages',
];
const buildQuoteSignature = (body: Record<string, any>): string => {
  const normalized: Record<string, any> = {};
  for (const key of SIGNATURE_FIELDS) {
    const v = body[key];
    normalized[key] = typeof v === 'string' ? v.trim().toLowerCase() : v ?? null;
  }
  return JSON.stringify(normalized);
};

const generateShipmentNumber = (): string => {
  const prefix = 'PC';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

// This endpoint returns decimal currency amounts. Magnitude never determines units.
const parseNpPrice = (raw: string | number): number => {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/.test(raw.trim()))) {
    throw new Error('Invalid amount in carrier rate response.');
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid amount in carrier rate response.');
  return Number(n.toFixed(2));
};

const calcTransitDays = (transitDays?: string | number, minDate?: string, maxDate?: string): number => {
  // Prefer direct transit_days from API
  if (transitDays !== undefined && transitDays !== null) {
    const d = parseInt(String(transitDays), 10);
    if (!isNaN(d) && d > 0) return d;
  }
  const dateStr = maxDate || minDate;
  if (!dateStr) return 5;
  const delivery = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((delivery.getTime() - today.getTime()) / 86400000);
  return Math.max(diff, 1);
};

// P.O. Box, case postale, general delivery / poste restante. "Box" alone needs a number so "Boxwood Dr" passes.
const PO_BOX = /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box|box\s*#?\s*\d+|c\.?\s*p\.?\s+\d+|case\s+postale|general\s+delivery|poste\s+restante)\b/i;
// First letter of a Canadian postal code -> province/territory (X is shared by NT and NU).
const CA_POSTAL_PROVINCES: Record<string, string[]> = {
  A: ['NL'], B: ['NS'], C: ['PE'], E: ['NB'], G: ['QC'], H: ['QC'], J: ['QC'], K: ['ON'], L: ['ON'], M: ['ON'], N: ['ON'], P: ['ON'],
  R: ['MB'], S: ['SK'], T: ['AB'], V: ['BC'], X: ['NT', 'NU'], Y: ['YT'],
};

// A future pickup is priced differently (e.g. UPS pickup charge), so the pickup date is sent as the ship date,
// as netParcel's Rate & Ship form does. Malformed or past dates are left out and netParcel prices for today.
const todayInToronto = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
export const rateShipDate = (date: unknown): string | undefined =>
  typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && date >= todayInToronto()
    ? date
    : undefined;

// ── POST /api/shipments/rates ────────────────────────────────────────────────
export const getRates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      originPostal, destinationPostal,
      originCity = '', destinationCity = '',
      originProvince = '', destinationProvince = '',
      originCountry = 'CA', destinationCountry = 'CA',
      originResidential = false, destinationResidential = false,
      originName = '', originCompany = '', originStreet = '', originStreet2 = '',
      originPhone = '', originEmail = '',
      destinationName = '', destinationCompany = '', destinationStreet = '', destinationStreet2 = '',
      destinationPhone = '', destinationEmail = '',
      weight, weightUnit = 'lbs',
      length, width, height, dimensionUnit = 'in',
      description = 'Package',
      insuranceAmount = 0,
      specialHandling = false,
      packagingType = 'My Packaging',
      freightClass,
      quoteType = 'quick',
      pickupMethod, // 'schedule_pickup' | 'drop_off' | undefined
      specialServices = {},
      packages,
      shipperType = 'consumer', consigneeType = 'consumer',
    } = req.body;

    if (![shipperType, consigneeType].every(type => type === 'consumer' || type === 'business')) {
      return res.status(400).json({ success: false, message: 'Party type must be consumer or business.' });
    }
    for (const [label, country, postal, city] of [
      ['Origin', originCountry, originPostal, originCity],
      ['Destination', destinationCountry, destinationPostal, destinationCity],
    ]) {
      if (typeof city !== 'string' || !city.trim()) return res.status(400).json({ success: false, message: `${label} city is required.` });
      if (typeof country !== 'string' || !isPostalFormatValid(country, postal ?? '')) {
        return res.status(400).json({ success: false, message: `${label} postal code is missing or invalid for the selected country.` });
      }
    }

    // Map frontend labels to valid netParcel packaging types
    const VALID_PACKAGING = ['My Packaging', 'Envelope', 'Pak', 'Pallet'];
    const resolvedPackaging = VALID_PACKAGING.includes(packagingType) ? packagingType : 'My Packaging';
    if (!VALID_PACKAGING.includes(packagingType)) return res.status(400).json({ success: false, message: 'Unsupported packaging type.' });

    const uom: 'I' | 'M' = (weightUnit === 'lbs' || dimensionUnit === 'in') ? 'I' : 'M';

    // Multi-package shipments: use the full packages[] array when provided (each package
    // rated individually by netParcel), falling back to the single flat weight/length/width/height
    // fields for callers that don't send packages[] (e.g. resumed saved quotes).
    const requestedRows: any[] = Array.isArray(packages) && packages.length > 0
      ? packages
      : [{ length, width, height, weight, insuranceAmount, description, specialHandling, freightClass }];
    // An envelope is one document envelope at netParcel's envelope limit, whatever the hidden package row holds
    const packageRows: any[] = resolvedPackaging === 'Envelope'
      ? [envelopePackage({ ...requestedRows[0], description: requestedRows[0]?.description || 'Documents' }, uom)]
      : requestedRows;

    for (const [index, p] of packageRows.entries()) {
      if (!p || !Number.isFinite(Number(p.weight)) || Number(p.weight) <= 0) {
        return res.status(400).json({ success: false, message: `Package ${index + 1}: weight must be greater than zero.` });
      }
      for (const dimension of ['length', 'width', 'height']) {
        const value = Number(p[dimension] ?? 0);
        if (!Number.isFinite(value) || value < 0 || (['My Packaging', 'Pallet'].includes(resolvedPackaging) && value === 0)) {
          return res.status(400).json({ success: false, message: `Package ${index + 1}: enter a valid ${dimension}.` });
        }
      }
    }

    // netParcel's API requires freight_class whenever packaging_type is "Pallet"
    if (resolvedPackaging === 'Pallet' && packageRows.some((p) => !p.freightClass)) {
      return res.status(400).json({ success: false, message: 'Freight class is required for Pallet (LTL) shipments.' });
    }

    const shipDate = rateShipDate(req.body.pickupDate);

    // Clean inputs
    const cleanPostal = (p: string, country?: string) => {
      const s = (p || '').trim().toUpperCase().replace(/\s+/g, '');
      if (!s) return null;
      // Canadian postal code: normalize to "A1A 1A1" format
      if ((country || 'CA') === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(s)) {
        return `${s.slice(0, 3)} ${s.slice(3)}`;
      }
      // US ZIP: normalize to "12345" or "12345-6789"
      if (country === 'US' && /^\d{9}$/.test(s)) {
        return `${s.slice(0, 5)}-${s.slice(5)}`;
      }
      return s;
    };
    // Full US state / CA province names → their 2-letter codes. Needed because geo
    // lookups and manually-typed forms often send the full name ("New York", "British
    // Columbia") rather than a code — the old "take the first word" fallback silently
    // turned "New York" into "NEW", an invalid state code that made UPS return zero
    // rates for the whole shipment while other carriers tolerated it.
    const US_STATE_CODES: Record<string, string> = {
      ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
      COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
      HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
      KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
      MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
      MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
      'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
      OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
      'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
      VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
      'DISTRICT OF COLUMBIA': 'DC',
    };
    const CA_PROVINCE_CODES: Record<string, string> = {
      ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', MANITOBA: 'MB', 'NEW BRUNSWICK': 'NB',
      'NEWFOUNDLAND AND LABRADOR': 'NL', 'NORTHWEST TERRITORIES': 'NT', 'NOVA SCOTIA': 'NS', NUNAVUT: 'NU',
      ONTARIO: 'ON', 'PRINCE EDWARD ISLAND': 'PE', QUEBEC: 'QC', SASKATCHEWAN: 'SK', YUKON: 'YT',
    };
    const cleanProvince = (p: string, country?: string) => {
      const s = (p || '').trim();
      if (!s) return null;
      const upper = s.toUpperCase();
      if ((country || 'CA') === 'US' && US_STATE_CODES[upper]) return US_STATE_CODES[upper];
      if ((country || 'CA') === 'CA' && CA_PROVINCE_CODES[upper]) return CA_PROVINCE_CODES[upper];
      // If it's already a short code (≤3 chars) use as-is
      if (s.length <= 3) return upper;
      // Otherwise take the first word as the code (e.g. "NWFP Peshawar" → "NWFP")
      return s.split(/\s+/)[0].toUpperCase();
    };
    // Geo lookups (e.g. zippopotam.us) can return neighborhood-qualified names like
    // "Ajax East" for a postal code whose canonical municipality is "Ajax" — netParcel's
    // carrier-matching expects the canonical city, so strip trailing directional suffixes.
    const cleanCity = (c: string) => (c || '').replace(/\s+(North\s?East|North\s?West|South\s?East|South\s?West|East|West|North|South)$/i, '').trim();

    // Address checks netParcel's API does not do at quote time (its Rate & Ship form does): couriers cannot pick up
    // from or deliver to a P.O. Box, and a Canadian postal code's first letter fixes the province.
    for (const [label, street, street2] of [
      ['Pickup', originStreet, originStreet2],
      ['Delivery', destinationStreet, destinationStreet2],
    ]) {
      if (PO_BOX.test(`${street || ''} ${street2 || ''}`)) {
        return res.status(400).json({ success: false,
          message: `${label} address identified as a P.O. Box. Please enter a street address; couriers cannot use P.O. Boxes and address correction fees may apply.` });
      }
    }
    for (const [label, country, postal, province] of [
      ['Origin', originCountry, originPostal, originProvince],
      ['Destination', destinationCountry, destinationPostal, destinationProvince],
    ]) {
      if (country !== 'CA') continue;
      const expected = CA_POSTAL_PROVINCES[String(postal || '').trim().toUpperCase().charAt(0)];
      const prov = cleanProvince(province, 'CA');
      if (expected && prov && !expected.includes(prov)) {
        return res.status(400).json({ success: false,
          message: `${label} postal code ${String(postal).trim().toUpperCase()} belongs to ${expected.join(' or ')}, not ${prov}. Please check the province or postal code.` });
      }
    }

    // netParcel rates UPS/FedEx/DHL dynamically based on full address, contact info,
    // address type (residential/business), and Pickup vs Drop-Off — blank/omitted values
    // here produce a different (and higher) rate than the Rate & Ship workflow, even
    // when postal/city/province/package data match exactly. Populate everything the
    // client has, and always send an explicit pick_up requirement.
    const ratePayload = {
      rate: {
        shipper_type: shipperType,
        consignee_type: consigneeType,
        ...(shipDate ? { ship_date: shipDate } : {}),
        origin: {
          country: originCountry,
          postal_code: cleanPostal(originPostal, originCountry) ?? '',
          province: cleanProvince(originProvince, originCountry) ?? '',
          city: cleanCity(originCity),
          name: originName || '',
          address1: originStreet || '',
          address2: originStreet2 || '',
          address3: '',
          phone: originPhone || '',
          fax: '',
          address_type: originResidential ? 'residential' : 'business',
          company_name: originCompany || '',
          email: originEmail || undefined,
        },
        destination: {
          country: destinationCountry,
          postal_code: cleanPostal(destinationPostal, destinationCountry) ?? '',
          province: cleanProvince(destinationProvince, destinationCountry) ?? '',
          city: cleanCity(destinationCity),
          name: destinationName || '',
          address1: destinationStreet || '',
          address2: destinationStreet2 || '',
          address3: '',
          phone: destinationPhone || '',
          fax: '',
          address_type: destinationResidential ? 'residential' : 'business',
          company_name: destinationCompany || '',
          email: destinationEmail || undefined,
        },
        // Explicit Pickup/Drop-Off — required by netParcel to match Rate & Ship pricing.
        // Defaults to Pickup (matches the booking flow's default) when not specified.
        pick_up: pickupMethod === 'drop_off'
          ? { required: false }
          : {
              required: true,
              location: req.body.pickupLocation || 'Front Door',
              instructions: req.body.pickupInstructions || '',
              ready_time: {
                ready_hour: req.body.readyHour || '09',
                ready_min: req.body.readyMin || '00',
              },
              close_time: {
                close_hour: req.body.closeHour || '17',
                close_min: req.body.closeMin || '00',
              },
            },
        breakdown_rates: true,
        // Special services affect UPS pricing significantly (confirmed: signature_required
        // alone accounts for the entire UPS discrepancy vs. Rate & Ship — ~$10.85-10.92 on
        // Worldwide Expedited/Express Saver for this route). Must mirror whatever the
        // reference/actual shipment configuration uses, since carriers price it differently
        // from DHL/FedEx/Purolator (which ignore it for rating purposes).
        special_services: {
          signature_required: !!specialServices.signatureRequired,
          adult_signature: !!specialServices.adultSignature,
          saturday_delivery: !!specialServices.saturdayDelivery,
          hold_for_pickup: !!specialServices.holdForPickup,
          inside_pickup: !!specialServices.insidePickup,
          inside_delivery: !!specialServices.insideDelivery,
          tailgate_pickup: !!specialServices.tailgatePickup,
          tailgate_delivery: !!specialServices.tailgateDelivery,
        },
        items: [{
          name: description || 'Package',
          quantity: 1,
          weight: packageRows.reduce((sum, p) => sum + (parseFloat(p.weight) || 0), 0),
          weightUnit: uom === 'I' ? 'lbs' : 'kg',
          price: packageRows.reduce((sum, p) => sum + (parseFloat(p.insuranceAmount) || 0), 0),
          requires_shipping: true,
          taxable: true,
        }],
        packaging_information: {
          packaging_type: resolvedPackaging,
          uom,
          packages: packageRows.map((p) => ({
            length: parseFloat(p.length) || 0,
            width: parseFloat(p.width) || 0,
            height: parseFloat(p.height) || 0,
            weight: parseFloat(p.weight) || 0,
            insurance_amount: parseFloat(p.insuranceAmount) || 0,
            description: p.description || description || 'Package',
            special_handling: !!p.specialHandling,
            // netParcel requires freight_class when packaging_type is "Pallet"
            ...(resolvedPackaging === 'Pallet' && p.freightClass ? { freight_class: String(p.freightClass) } : {}),
          })),
        },
      },
    };

    logger.info('netParcel rate payload: ' + JSON.stringify(ratePayload));

    let npRates;
    let notice: string | undefined;
    try {
      npRates = await netparcelService.getRates(ratePayload);
      // Exclude netParcel's own generic/non-bookable "Preferred Pickup" placeholder rate (code 380000, no tariff)
      npRates = npRates.filter((r: any) => r.service_code !== '380000');
      // Purolator rejects Hold for Pickup with "signature not required" (netParcel's form refuses the whole quote), yet
      // the API still prices it. Drop Purolator for that combination rather than offer services that fail at booking.
      if (specialServices.holdForPickup && !specialServices.signatureRequired && !specialServices.adultSignature) {
        const before = npRates.length;
        npRates = npRates.filter((r: any) => !/^purolator\b/i.test(String(r.service_name || '')));
        if (npRates.length < before) notice = 'Purolator is not available with Hold for Pickup unless a signature is required.';
      }
      logger.info(`netParcel returned ${npRates.length} rates`);
      if (!npRates.length) {
        const message = notice
          ? `${notice} No other carrier serves this shipment; require a signature or turn off Hold for Pickup.`
          : 'No carrier returned a rate for these shipment details. Review the package weight, dimensions, packaging type, requested services and route, or contact support.';
        return res.status(422).json({ success: false, message });
      }
    } catch (err: any) {
      logger.error('netParcel getRates failed:', err?.message || err);
      return res.status(err?.statusCode === 422 ? 422 : 502).json({ success: false,
        message: err?.statusCode === 422 ? err.message : 'Unable to fetch shipping rates. Please try again.',
        ...(err?.carrierErrors ? { carrierErrors: err.carrierErrors } : {}) });
    }

    const normalized = npRates.map((r: any) => ({
      carrierId: r.service_code,
      carrierName: r.service_name.split(' ')[0],
      serviceCode: r.service_code,
      serviceName: r.service_name,
      totalCharge: applyMarkup(parseNpPrice(r.total_price)),
      tariffPrice: parseNpPrice(r.tarriff_price || r.tariff_price || 0),
      currency: String(r.currency || 'CAD').trim().toUpperCase(),
      transitDays: calcTransitDays(r.transit_days, r.min_delivery_date, r.max_delivery_date),
      estimatedDelivery: normalizeDeliveryDate(r.max_delivery_date || r.min_delivery_date || ''),
      mode: r.mode, // 1=Express, 2=Ground
    }));

    const rates = tagRates(normalized);

    const userId = (req as any).user?.userId;
    if (userId) {
      const resolvedType: 'quick' | 'detailed' = quoteType === 'detailed' ? 'detailed' : 'quick';
      const validityDays = QUOTE_VALIDITY_DAYS[resolvedType];
      try {
        await SavedQuote.findOneAndUpdate(
          { user: userId, type: resolvedType, signature: buildQuoteSignature(req.body) },
          {
            user: userId,
            type: resolvedType,
            signature: buildQuoteSignature(req.body),
            formData: req.body,
            rates,
            expiresAt: new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true }
        );
      } catch (err) {
        logger.error('Failed to save quote:', err);
      }
    }

    res.json({ success: true, rates, count: rates.length, ...(notice ? { notice } : {}) });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/shipments/book ─────────────────────────────────────────────────
export const bookShipment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      shipper, recipient, parcels, selectedRate,
      shipmentType, guestEmail, guestPhone,
      pickupDetails, specialServices, references,
      packagingType, customsInvoice, notifyRecipient,
    } = req.body;
    const userId = (req as any).user?.userId;

    if (references !== undefined && (!Array.isArray(references) || references.length > 3)) {
      return res.status(400).json({ success: false, message: 'A maximum of three customer references is supported.' });
    }

    if (!userId) throw requestError(401, 'Authentication required.');
    if (!shipper || !recipient || !Array.isArray(parcels) || !parcels.length || !selectedRate) {
      throw requestError(400, 'Addresses, packages and a selected service are required.');
    }
    if (shipmentType === 'international' && customsInvoice) {
      customsInvoice.reasonForExport = customsInvoice.reasonForExport || DEFAULT_EXPORT_REASON;
      if (!CUSTOMS_EXPORT_REASONS.includes(customsInvoice.reasonForExport)) {
        throw requestError(400, 'Unsupported reason for export for the customs invoice.');
      }
      if (customsInvoice.taxType && customsInvoice.taxType !== 'None' && !CUSTOMS_TAX_TYPES.includes(customsInvoice.taxType)) {
        throw requestError(400, 'Unsupported tax ID type for the customs invoice.');
      }
      if (!Array.isArray(customsInvoice.products) || !customsInvoice.products.length ||
          customsInvoice.products.some((p: any) => !p?.description || !p?.hsCode || !p?.madeIn)) {
        throw requestError(400, 'Each customs product needs a description, HS code and country of origin.');
      }
    }
    const quoteBody: Record<string, any> = {
      packages: parcels, packagingType, specialServices,
      weightUnit: parcels[0].weightUnit, dimensionUnit: parcels[0].dimensionUnit,
      pickupMethod: pickupDetails?.method || 'drop_off', pickupDate: pickupDetails?.pickupDate,
      pickupLocation: pickupDetails?.location, pickupInstructions: pickupDetails?.instructions,
      readyHour: pickupDetails?.readyHour, readyMin: pickupDetails?.readyMin,
      closeHour: pickupDetails?.closeHour, closeMin: pickupDetails?.closeMin,
      shipperType: shipper.addressType || 'consumer', consigneeType: recipient.addressType || 'consumer',
    };
    for (const [prefix, address] of [['origin', shipper], ['destination', recipient]] as const) {
      for (const [suffix, field] of Object.entries({ Postal: 'postalCode', City: 'city', Province: 'province', Country: 'country', Residential: 'isResidential', Name: 'name', Company: 'company', Street: 'street', Street2: 'street2', Phone: 'phone', Email: 'email' })) {
        quoteBody[prefix + suffix] = address[field];
      }
    }
    let quoteStatus = 200;
    let quoteResult: any;
    await getRates({ body: quoteBody } as Request, {
      status(code: number) { quoteStatus = code; return this; },
      json(data: any) { quoteResult = data; return this; },
    } as Response, error => { throw error; });
    if (quoteStatus !== 200) return res.status(quoteStatus).json(quoteResult);
    const authoritativeRate = quoteResult.rates.find((rate: any) =>
      String(rate.serviceCode) === String(selectedRate.serviceCode) &&
      rate.currency === String(selectedRate.currency || '').toUpperCase());
    if (!authoritativeRate || Number(selectedRate.totalCharge) !== authoritativeRate.totalCharge) {
      return res.status(409).json({ success: false, code: authoritativeRate ? 'RATE_CHANGED' : 'RATE_UNAVAILABLE',
        message: 'Rates have changed. Please review and select a current rate.', rates: quoteResult.rates });
    }

    const shipmentNumber = generateShipmentNumber();

    const shipment = await Shipment.create({
      shipmentNumber,
      userId: userId || undefined,
      guestEmail: userId ? undefined : guestEmail,
      guestPhone: userId ? undefined : guestPhone,
      shipper,
      recipient,
      parcels,
      packagingType: packagingType || 'My Packaging',
      selectedRate: authoritativeRate,
      shipmentType,
      pickupDetails,
      specialServices,
      references,
      customsInvoice,
      notifyRecipient: notifyRecipient !== false,
      status: 'pending_payment',
      payment: {
        amount: authoritativeRate.totalCharge,
        currency: authoritativeRate.currency,
        priceVerified: true,
        status: 'pending',
      },
    });

    res.status(201).json({
      success: true,
      message: 'Shipment created. Proceed to payment.',
      shipmentId: shipment._id,
      shipmentNumber: shipment.shipmentNumber,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/shipments/:id/confirm-payment ──────────────────────────────────
export const confirmPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { method, transactionId } = req.body;

    const owned = await ownedShipment(req, id);
    if (method !== 'stripe' || typeof transactionId !== 'string' || transactionId !== owned.payment.stripeIntentId) {
      throw requestError(400, 'A verified Stripe payment is required. Use the PayPal capture endpoint for PayPal.');
    }
    const intent = await stripe.paymentIntents.retrieve(transactionId);
    const check = checkStripeIntent(intent, owned);
    if (!check.ok) throw requestError(400, 'Payment verification failed.');
    const shipment = await settlePayment(owned, 'stripe', intent.id);
    const labelGenerated = !!shipment.netparcelOrderId;

    res.json({
      success: true,
      message: labelGenerated
        ? 'Payment confirmed and label generated.'
        : 'Payment confirmed. Your label is pending; contact support if it remains unavailable.',
      shipment: {
        shipmentNumber: shipment.shipmentNumber,
        trackingNumber: shipment.trackingNumber,
        status: shipment.status,
        labelUrl: shipment.labelUrl,
        labelBase64: shipment.labelBase64 ? `data:application/pdf;base64,${shipment.labelBase64}` : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/shipments/track/:trackingNumber ─────────────────────────────────
export const trackShipment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { trackingNumber } = req.params;

    const shipment = await Shipment.findOne({ trackingNumber }).lean();

    let liveTracking = null;
    if (shipment?.netparcelOrderId) {
      try {
        const order = await netparcelService.getOrder(shipment.netparcelOrderId, trackingNumber);
        liveTracking = {
          status: order?.status?.status_name,
          carrier: order?.service_name,
          trackingUrl: order?.tracking_url,
          charges: order?.charges,
        };
      } catch {
        logger.warn('Live tracking unavailable for:', trackingNumber);
      }
    }

    if (!shipment && !liveTracking) {
      return res.status(404).json({ success: false, message: 'Tracking number not found. Please check and try again.' });
    }

    res.json({
      success: true,
      tracking: {
        trackingNumber,
        status: liveTracking?.status || shipment?.status || 'unknown',
        carrier: liveTracking?.carrier || shipment?.selectedRate?.carrierName,
        serviceName: shipment?.selectedRate?.serviceName,
        estimatedDelivery: shipment?.selectedRate?.estimatedDelivery,
        trackingUrl: liveTracking?.trackingUrl || shipment?.labelUrl,
        shipper: shipment ? { city: shipment.shipper.city, province: shipment.shipper.province, country: shipment.shipper.country } : null,
        recipient: shipment ? { city: shipment.recipient.city, province: shipment.recipient.province, country: shipment.recipient.country } : null,
        statusHistory: shipment?.statusHistory || [],
        liveTracking,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/shipments/:id/label ─────────────────────────────────────────────
export const downloadLabel = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?.userId;

    if (!/^[a-f\d]{24}$/i.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid shipment ID.' });
    }
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required.' });

    const shipment = await Shipment.findById(id);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    if (!shipment.userId || shipment.userId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }

    // If we stored the base64 label, re-fetch from netParcel order if missing
    if (!shipment.labelBase64 && shipment.netparcelOrderId) {
      try {
        const order = await netparcelService.getOrder(shipment.netparcelOrderId, shipment.trackingNumber);
        const labelDoc = order?.documents?.find((d: any) => d.document_name === 'labels');
        if (labelDoc?.base64_encoded_string) {
          shipment.labelBase64 = labelDoc.base64_encoded_string;
          await shipment.save();
        }
      } catch (err) {
        logger.warn('Failed to re-fetch label from netParcel:', err);
      }
    }

    if (!shipment.labelBase64) {
      return res.status(404).json({ success: false, message: 'Label not yet available for this shipment.' });
    }

    res.json({
      success: true,
      label: `data:application/pdf;base64,${shipment.labelBase64}`,
      trackingNumber: shipment.trackingNumber,
      shipmentNumber: shipment.shipmentNumber,
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/shipments/:id/cancel ───────────────────────────────────────────
export const cancelShipment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = req.body;

    // Owner-only: ownerless (legacy guest) shipments are refused, as for labels and invoices
    const shipment = await ownedShipment(req, req.params.id);

    const cancellableStatuses = ['pending_payment', 'paid', 'label_generated', 'pickup_scheduled'];
    if (!cancellableStatuses.includes(shipment.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel a shipment with status: ${shipment.status}.` });
    }

    // The carrier must confirm CANCELLED; netParcel can answer 200 with errors and the unchanged status.
    if (shipment.netparcelOrderId) {
      let carrierStatus = '';
      let carrierErrors: string[] = [];
      try {
        const result: any = await netparcelService.cancelShipment(shipment.netparcelOrderId);
        carrierStatus = String(result?.shipment?.status || '').toUpperCase();
        carrierErrors = [result?.errorMessage, ...(result?.errorMessages || [])].filter((m) => typeof m === 'string' && m.trim());
      } catch (err) {
        logger.warn(`netParcel carrier cancellation failed for shipment ${shipment._id}:`, err);
      }
      if (carrierStatus !== 'CANCELLED') {
        return res.status(502).json({ success: false,
          message: 'The carrier could not cancel this shipment, so it has not been cancelled. Please try again or contact support.',
          ...(carrierErrors.length ? { carrierErrors: carrierErrors.slice(0, 5) } : {}) });
      }
    }

    const now = new Date();
    const hoursSinceCreation = (now.getTime() - shipment.createdAt.getTime()) / (1000 * 60 * 60);

    let refundAmount = 0;
    let refundNote = '';

    if (hoursSinceCreation <= 24 && shipment.status !== 'pickup_scheduled') {
      refundAmount = shipment.payment.amount || 0;
      refundNote = 'Full refund — cancelled within 24 hours.';
    } else if (shipment.status === 'pickup_scheduled') {
      refundAmount = Math.max(0, (shipment.payment.amount || 0) - 25);
      refundNote = '$25 deducted for driver dispatch.';
    } else {
      refundNote = 'Refund requires written review (after 24h).';
      refundAmount = 0;
    }

    shipment.status = 'cancelled';
    shipment.cancellation = {
      requestedAt: now,
      reason: reason || 'Customer requested cancellation',
      refundAmount,
      notes: refundNote,
    };

    await shipment.save();

    const contactEmail = shipment.guestEmail || '';
    if (contactEmail) {
      await emailService.sendCancellationConfirmation(contactEmail, shipment, refundAmount);
    }

    res.json({ success: true, message: 'Shipment cancelled.', refundAmount, refundNote });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/shipments/my ────────────────────────────────────────────────────
// Sorted server-side so ordering holds across pages.
const HISTORY_SORTS: Record<string, Record<string, 1 | -1>> = {
  createdAt_desc: { createdAt: -1 },
  createdAt_asc: { createdAt: 1 },
  amount_desc: { 'payment.amount': -1, createdAt: -1 },
  amount_asc: { 'payment.amount': 1, createdAt: -1 },
};

export const getMyShipments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = new mongoose.Types.ObjectId((req as any).user.userId);
    const { page = 1, limit = 10, status, excludeStatus, sortBy, search, dateFrom, dateTo } = req.query;

    const query: any = { userId };
    if (typeof status === 'string' && status && status !== 'all') query.status = status;
    else if (typeof excludeStatus === 'string' && excludeStatus) query.status = { $ne: excludeStatus };
    if (search) {
      query.$or = [
        { shipmentNumber: { $regex: search, $options: 'i' } },
        { trackingNumber: { $regex: search, $options: 'i' } },
        { 'shipper.city': { $regex: search, $options: 'i' } },
        { 'recipient.city': { $regex: search, $options: 'i' } },
      ];
    }
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom as string);
      if (dateTo) { const end = new Date(dateTo as string); end.setHours(23, 59, 59, 999); query.createdAt.$lte = end; }
    }

    const shipments = await Shipment.find(query)
      .sort(HISTORY_SORTS[String(sortBy)] || HISTORY_SORTS.createdAt_desc)
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    const total = await Shipment.countDocuments(query);

    res.json({
      success: true,
      shipments,
      pagination: { page: +page, limit: +limit, total, pages: Math.ceil(total / +limit) },
    });
  } catch (error) {
    next(error);
  }
};
