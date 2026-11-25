// Single source of truth for Pilot Courier contact details on the backend.
// CONTACT_EMAIL may override the address that receives contact-form messages.
export const COMPANY_EMAIL = 'pilotcourier@live.com';

// Fee kept back when a booking is cancelled after the pickup was scheduled. It is a business rule, not a carrier
// price, so it lives in one place and can be changed with CANCELLATION_DISPATCH_FEE (CAD) without a code change.
const dispatchFee = Number(process.env.CANCELLATION_DISPATCH_FEE);
export const CANCELLATION_DISPATCH_FEE = Number.isFinite(dispatchFee) && dispatchFee >= 0 ? dispatchFee : 25;
