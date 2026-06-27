import axios, { AxiosInstance } from 'axios';
import logger from '../utils/logger';

// ─── netParcel JSON API types ────────────────────────────────────────────────

interface NpAddress {
  country: string;
  postal_code: string;
  province: string;
  city: string;
  name: string;
  address1: string;
  address2?: string | null;
  address3?: string | null;
  phone?: string | null;
  fax?: string | null;
  address_type?: string | null;
  company_name?: string | null;
  email?: string;
}

interface NpPackage {
  length: number;
  width: number;
  height: number;
  weight: number;
  insurance_amount?: number;
  description?: string;
  freight_class?: string;
  nmfc_code?: string;
  type?: string;
  special_handling?: boolean;
}

interface NpPackagingInformation {
  packaging_type: string;
  uom?: 'I' | 'M';
  packages: NpPackage[];
}

interface NpRateRequest {
  rate: {
    origin: NpAddress;
    destination: NpAddress;
    items?: any[];
    packaging_information: NpPackagingInformation;
    breakdown_rates?: boolean;
  };
}

interface NpRate {
  service_name: string;
  service_code: string;
  total_price: string;
  currency: string;
  min_delivery_date?: string;
  max_delivery_date?: string;
  tariff_price?: string;
  mode?: string;
}

interface NpShipRequest {
  ship: {
    origin: NpAddress;
    destination: NpAddress & { email?: string; send_email_confirmation?: boolean };
    service: { service_code: number | string; service_name?: string };
    ship_date: string;
    packaging_information: NpPackagingInformation;
    references?: Array<{ reference_name: string; reference_value: string }>;
    generate_label?: boolean;
    special_services?: Record<string, any>;
    customs_invoice?: any;
    pick_up?: any;
  };
}

interface NpShipResponse {
  shipment: {
    charges: Array<{ charge_name: string; charge_code: string; charge_amount: number }>;
    master_tracking_num: string;
    total_price: number;
    documents: Array<{ document_name: string; base64_encoded_string: string }>;
    service_name: string;
    service_code: string;
    currency: string;
    order_id: number;
    tracking_url: string;
    status: { status_name: string };
    packaging_information?: any;
  };
}

interface NpCancelResponse {
  shipment: {
    status: string;
    order_id: number;
  };
  errorMessages?: string[];
}

interface NpOrderResponse {
  order: {
    charges: Array<{ charge_name: string; charge_code: string; charge_amount: number }>;
    master_tracking_num: string;
    total_price: number;
    documents: Array<{ document_name: string; base64_encoded_string: string }>;
    service_name: string;
    service_code: string;
    currency: string;
    order_id: number;
    tracking_url: string;
    status: { status_name: string };
  };
}

// ─── Service ─────────────────────────────────────────────────────────────────

class NetParcelService {
  private client: AxiosInstance;
  private username: string;
  private password: string;

  constructor() {
    this.username = process.env.NETPARCEL_USERNAME || '';
    this.password = process.env.NETPARCEL_PASSWORD || '';
    const baseUrl = process.env.NETPARCEL_API_URL || 'https://test.netparcel.com';

    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        API_USERNAME: this.username,
        API_PASSWORD: this.password,
      },
      timeout: 30000,
    });
  }

  async getRates(data: NpRateRequest): Promise<NpRate[]> {
    try {
      logger.info(`netParcel request to ${this.client.defaults.baseURL}/fetch_rates`);
      logger.info(`netParcel auth: user="${this.username}" pass="${this.password ? '***set***' : 'MISSING'}"`);
      const response = await this.client.post('/fetch_rates', data);
      logger.info(`netParcel raw response status: ${response.status}`);
      logger.info(`netParcel raw response keys: ${Object.keys(response.data || {}).join(', ')}`);
      logger.info(`netParcel raw response: ${JSON.stringify(response.data).slice(0, 500)}`);
      const rates: NpRate[] = response.data?.rates || [];
      const errors = response.data?.errors || [];

      if (errors.length) {
        errors.forEach((e: any) => logger.warn(`netParcel error: ${e.errorMessage}`));
      }
      if (!rates.length) {
        logger.warn('No rates returned from netParcel for given shipment details');
      }

      return rates;
    } catch (error: any) {
      logger.error(`netParcel getRates error status: ${error?.response?.status}`);
      logger.error(`netParcel getRates error data: ${JSON.stringify(error?.response?.data || error.message)}`);
      throw new Error(error?.response?.data?.message || 'Failed to fetch shipping rates');
    }
  }

  async createShipment(data: NpShipRequest): Promise<NpShipResponse['shipment']> {
    try {
      const response = await this.client.post('/shipping_service', data);
      return response.data?.shipment;
    } catch (error: any) {
      logger.error('netParcel createShipment error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create shipment with netParcel');
    }
  }

  async cancelShipment(orderId: number): Promise<NpCancelResponse> {
    try {
      const response = await this.client.post('/shipping_service', {
        cancel: { order_id: orderId },
      });
      return response.data;
    } catch (error: any) {
      logger.error('netParcel cancelShipment error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to cancel shipment');
    }
  }

  async getOrder(orderId: number, trackingNumber?: string): Promise<NpOrderResponse['order']> {
    try {
      const payload: any = { order: { order_id: orderId } };
      if (trackingNumber) payload.order.tracking_number = trackingNumber;

      const response = await this.client.post('/shipping_service', payload);
      return response.data?.order;
    } catch (error: any) {
      logger.error('netParcel getOrder error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to retrieve order information');
    }
  }

  // ── Helpers to build API payloads from internal models ───────────────────

  buildAddress(addr: {
    name: string;
    company?: string;
    street: string;
    street2?: string;
    city: string;
    province: string;
    postalCode: string;
    country: string;
    phone: string;
    email?: string;
  }, addressType?: string): NpAddress {
    return {
      country: addr.country,
      postal_code: addr.postalCode,
      province: addr.province,
      city: addr.city,
      name: addr.name,
      address1: addr.street,
      address2: addr.street2 || null,
      phone: addr.phone,
      company_name: addr.company || null,
      address_type: addressType || null,
      fax: null,
      address3: null,
      email: addr.email,
    };
  }

  buildPackagingInformation(
    parcels: Array<{
      weight: number;
      weightUnit: string;
      length: number;
      width: number;
      height: number;
      dimensionUnit: string;
      description: string;
      declaredValue?: number;
    }>,
  ): NpPackagingInformation {
    // Determine uom from first parcel's units
    const firstParcel = parcels[0];
    const uom = firstParcel?.weightUnit === 'lbs' ? 'I' : 'M';

    return {
      packaging_type: 'My Packaging',
      uom,
      packages: parcels.map((p) => ({
        length: p.length,
        width: p.width,
        height: p.height,
        weight: p.weight,
        insurance_amount: p.declaredValue || 0,
        description: p.description || 'Package',
      })),
    };
  }

  // ── Mock rates for dev/testing when credentials aren't available ──────────

  getMockRates(weight: number, currency = 'CAD'): NpRate[] {
    const base = 12.99 + weight * 2.5;
    const future = (days: number) =>
      new Date(Date.now() + days * 86400000).toISOString().split('T')[0] + ' 17:00:00';

    return [
      {
        service_name: 'UPS Standard',
        service_code: '204',
        total_price: String((base).toFixed(0)),
        currency,
        min_delivery_date: future(5),
        max_delivery_date: future(5),
      },
      {
        service_name: 'UPS Expedited',
        service_code: '201',
        total_price: String((base + 800).toFixed(0)),
        currency,
        min_delivery_date: future(3),
        max_delivery_date: future(3),
      },
      {
        service_name: 'UPS Express',
        service_code: '200',
        total_price: String((base + 1500).toFixed(0)),
        currency,
        min_delivery_date: future(2),
        max_delivery_date: future(2),
      },
      {
        service_name: 'Purolator PurolatorGround',
        service_code: '2016',
        total_price: String((base + 200).toFixed(0)),
        currency,
        min_delivery_date: future(4),
        max_delivery_date: future(4),
      },
    ];
  }
}

export { NpRate, NpShipResponse };
export default new NetParcelService();
