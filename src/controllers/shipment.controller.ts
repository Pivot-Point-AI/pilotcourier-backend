import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Shipment from '../models/Shipment';
import netparcelService from '../services/netparcel.service';
import emailService from '../services/email.service';
import logger from '../utils/logger';

const generateShipmentNumber = (): string => {
  const prefix = 'PC';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

// netParcel total_price: older API returns cents ("3400" = $34.00), newer returns dollars ("14.89")
const parseNpPrice = (raw: string | number): number => {
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (isNaN(n)) return 0;
  // Heuristic: if value > 500 and has no decimal, treat as cents
  return (n > 500 && Number.isInteger(n)) ? parseFloat((n / 100).toFixed(2)) : parseFloat(n.toFixed(2));
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

const tagRates = (rates: any[]) => {
  if (!rates.length) return rates;
  const cheapest = [...rates].sort((a, b) => a.totalCharge - b.totalCharge)[0];
  const fastest = rates.reduce((a, b) => (a.transitDays < b.transitDays ? a : b));
  const bestValue = rates.reduce((a, b) =>
    a.totalCharge / Math.max(a.transitDays, 1) < b.totalCharge / Math.max(b.transitDays, 1) ? a : b
  );
  return rates.map((r) => ({
    ...r,
    isCheapest: r.serviceCode === cheapest.serviceCode,
    isFastest: r.serviceCode === fastest.serviceCode,
    isBestValue: r.serviceCode === bestValue.serviceCode,
  }));
};

// ── POST /api/shipments/rates ────────────────────────────────────────────────
export const getRates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      originPostal, destinationPostal,
      originCity = '', destinationCity = '',
      originProvince = '', destinationProvince = '',
      originCountry = 'CA', destinationCountry = 'CA',
      originResidential = false, destinationResidential = false,
      weight, weightUnit = 'lbs',
      length, width, height, dimensionUnit = 'in',
      description = 'Package',
      insuranceAmount = 0,
      specialHandling = false,
      packagingType = 'My Packaging',
    } = req.body;

    // Map frontend labels to valid netParcel packaging types
    const VALID_PACKAGING = ['My Packaging', 'Envelope', 'Pak', 'Pallet'];
    const resolvedPackaging = VALID_PACKAGING.includes(packagingType) ? packagingType : 'My Packaging';

    const uom: 'I' | 'M' = (weightUnit === 'lbs' || dimensionUnit === 'in') ? 'I' : 'M';

    // Clean inputs
    const cleanPostal = (p: string) => (p || '').trim() || null;
    const cleanProvince = (p: string) => {
      const s = (p || '').trim();
      if (!s) return null;
      // If it's already a short code (≤3 chars) use as-is
      if (s.length <= 3) return s.toUpperCase();
      // Otherwise take the first word as the code (e.g. "NWFP Peshawar" → "NWFP")
      return s.split(/\s+/)[0].toUpperCase();
    };

    const ratePayload = {
      rate: {
        origin: {
          country: originCountry,
          postal_code: cleanPostal(originPostal) ?? '',
          province: cleanProvince(originProvince) ?? '',
          city: originCity || '',
          name: '',
          address1: '',
          address2: '',
          address3: '',
          phone: '',
          fax: '',
          address_type: originResidential ? 'residential' : '',
          company_name: '',
        },
        destination: {
          country: destinationCountry,
          postal_code: cleanPostal(destinationPostal) ?? '',
          province: cleanProvince(destinationProvince) ?? '',
          city: destinationCity || '',
          name: '',
          address1: '',
          address2: '',
          address3: '',
          phone: '',
          fax: '',
          address_type: destinationResidential ? 'residential' : '',
          company_name: '',
        },
        packaging_information: {
          packaging_type: resolvedPackaging,
          uom,
          packages: [{
            length: parseFloat(length) || 0,
            width: parseFloat(width) || 0,
            height: parseFloat(height) || 0,
            weight: parseFloat(weight),
            insurance_amount: parseFloat(insuranceAmount) || 0,
            description: description || 'Package',
            special_handling: !!specialHandling,
          }],
        },
      },
    };

    logger.info('netParcel rate payload: ' + JSON.stringify(ratePayload));

    let npRates;
    try {
      npRates = await netparcelService.getRates(ratePayload);
      logger.info(`netParcel returned ${npRates.length} rates`);
      if (!npRates.length) {
        const isInternational = originCountry !== destinationCountry;
        const message = isInternational
          ? 'No international shipping rates are currently available for this route. Please contact support or try a domestic shipment.'
          : 'No shipping rates available for the selected route. Please check the addresses and try again.';
        return res.status(422).json({ success: false, message });
      }
    } catch (err: any) {
      logger.error('netParcel getRates failed:', err?.message || err);
      return res.status(502).json({ success: false, message: err?.message || 'Unable to fetch shipping rates. Please try again.' });
    }

    const normalized = npRates.map((r: any) => ({
      carrierId: r.service_code,
      carrierName: r.service_name.split(' ')[0],
      serviceCode: r.service_code,
      serviceName: r.service_name,
      totalCharge: parseNpPrice(r.total_price),
      tariffPrice: parseNpPrice(r.tarriff_price || r.tariff_price || 0),
      currency: r.currency || 'CAD',
      transitDays: calcTransitDays(r.transit_days, r.min_delivery_date, r.max_delivery_date),
      estimatedDelivery: (() => {
        const d = r.max_delivery_date || r.min_delivery_date || '';
        // Handle "21 May 2026" → parse to ISO, handle "2026-05-21" → use as-is
        if (!d) return '';
        const parsed = new Date(d);
        return isNaN(parsed.getTime()) ? d : parsed.toISOString().split('T')[0];
      })(),
      mode: r.mode, // 1=Express, 2=Ground
    }));

    const rates = tagRates(normalized);
    res.json({ success: true, rates, count: rates.length });
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
    } = req.body;
    const userId = (req as any).user?.userId;

    const shipmentNumber = generateShipmentNumber();

    const shipment = await Shipment.create({
      shipmentNumber,
      userId: userId || undefined,
      guestEmail: userId ? undefined : guestEmail,
      guestPhone: userId ? undefined : guestPhone,
      shipper,
      recipient,
      parcels,
      selectedRate,
      shipmentType,
      pickupDetails,
      specialServices,
      references,
      status: 'pending_payment',
      payment: {
        amount: selectedRate.totalCharge,
        currency: selectedRate.currency || 'CAD',
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

    const shipment = await Shipment.findById(id);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    shipment.payment.method = method;
    shipment.payment.status = 'completed';
    shipment.payment.transactionId = transactionId;
    shipment.payment.paidAt = new Date();
    shipment.status = 'paid';

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
      refs.unshift({ reference_name: 'Order', reference_value: shipment.shipmentNumber });

      const shipPayload = {
        ship: {
          origin: {
            ...netparcelService.buildAddress(shipment.shipper),
            address_type: shipment.shipper.isResidential ? 'residential' : null,
          },
          destination: {
            ...netparcelService.buildAddress(shipment.recipient),
            address_type: shipment.recipient.isResidential ? 'residential' : null,
            email: shipment.recipient.email,
            send_email_confirmation: !!shipment.recipient.email,
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
          packaging_information: netparcelService.buildPackagingInformation(shipment.parcels),
          references: refs.slice(0, 3),
          generate_label: true,
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
    } catch (labelErr) {
      logger.warn('Label generation failed, shipment still marked as paid:', labelErr);
      shipment.trackingNumber = `PC${Date.now()}`;
      shipment.status = 'label_generated';
    }

    await shipment.save();

    const contactEmail = shipment.guestEmail || shipment.recipient.email || '';
    if (contactEmail) {
      await emailService.sendBookingConfirmation(contactEmail, shipment, shipment.guestPhone);
    }

    res.json({
      success: true,
      message: 'Payment confirmed and label generated.',
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

    const shipment = await Shipment.findById(id);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    if (shipment.userId && userId && shipment.userId.toString() !== userId) {
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
    const { id } = req.params;
    const { reason } = req.body;
    const userId = (req as any).user?.userId;

    const shipment = await Shipment.findById(id);
    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    if (shipment.userId && shipment.userId.toString() !== userId) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }

    const cancellableStatuses = ['pending_payment', 'paid', 'label_generated'];
    if (!cancellableStatuses.includes(shipment.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel a shipment with status: ${shipment.status}.` });
    }

    if (shipment.netparcelOrderId) {
      try {
        await netparcelService.cancelShipment(shipment.netparcelOrderId);
      } catch (err) {
        logger.warn('netParcel carrier cancellation failed (continuing with internal cancel):', err);
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
export const getMyShipments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = new mongoose.Types.ObjectId((req as any).user.userId);
    const { page = 1, limit = 10, status, search, dateFrom, dateTo } = req.query;

    const query: any = { userId };
    if (status && status !== 'all') query.status = status;
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
      .sort({ createdAt: -1 })
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
