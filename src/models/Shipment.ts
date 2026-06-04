import mongoose, { Document, Schema } from 'mongoose';

export type ShipmentStatus =
  | 'quote'
  | 'pending_payment'
  | 'paid'
  | 'label_generated'
  | 'pickup_scheduled'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'refund_requested'
  | 'refunded';

export interface IAddress {
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
  isResidential?: boolean;
}

export interface IParcel {
  weight: number;
  weightUnit: 'kg' | 'lbs';
  length: number;
  width: number;
  height: number;
  dimensionUnit: 'cm' | 'in';
  description: string;
  declaredValue?: number;
  insuranceAmount?: number;
  specialHandling?: boolean;
  quantity: number;
}

export interface IPickupDetails {
  method: 'schedule_pickup' | 'drop_off';
  location?: string;
  instructions?: string;
  pickupDate?: string;
  readyHour?: string;
  readyMin?: string;
  closeHour?: string;
  closeMin?: string;
}

export interface ISpecialServices {
  saturdayDelivery?: boolean;
  signatureRequired?: boolean;
  adultSignature?: boolean;
  holdForPickup?: boolean;
  insidePickup?: boolean;
  insideDelivery?: boolean;
  tailgatePickup?: boolean;
  tailgateDelivery?: boolean;
}

export interface IReference {
  referenceName: string;
  referenceValue: string;
}

export interface IRate {
  carrierId: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  totalCharge: number;
  currency: string;
  transitDays: number;
  estimatedDelivery?: string;
  isCheapest?: boolean;
  isFastest?: boolean;
  isBestValue?: boolean;
}

export interface IShipment extends Document {
  shipmentNumber: string;
  userId?: mongoose.Types.ObjectId;
  guestEmail?: string;
  guestPhone?: string;
  shipper: IAddress;
  recipient: IAddress;
  parcels: IParcel[];
  shipmentType: 'domestic' | 'international';
  selectedRate: IRate;
  allRates: IRate[];
  pickupDetails?: IPickupDetails;
  specialServices?: ISpecialServices;
  references?: IReference[];
  status: ShipmentStatus;
  trackingNumber?: string;
  labelUrl?: string;
  labelBase64?: string;
  netparcelOrderId?: number;
  payment: {
    method?: 'stripe' | 'paypal' | 'wise' | 'remitly';
    status: 'pending' | 'completed' | 'failed' | 'refunded';
    transactionId?: string;
    amount: number;
    currency: string;
    paidAt?: Date;
  };
  cancellation?: {
    requestedAt: Date;
    reason: string;
    refundAmount: number;
    processedAt?: Date;
    notes?: string;
  };
  statusHistory: Array<{
    status: ShipmentStatus;
    timestamp: Date;
    note?: string;
  }>;
  adminNotes?: string;
  manualPriceOverride?: number;
  createdAt: Date;
  updatedAt: Date;
}

const AddressSchema = new Schema<IAddress>({
  name: { type: String, required: true },
  company: { type: String },
  street: { type: String, required: true },
  street2: { type: String },
  city: { type: String, required: true },
  province: { type: String, required: true },
  postalCode: { type: String, required: true },
  country: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  isResidential: { type: Boolean, default: false },
});

const ParcelSchema = new Schema<IParcel>({
  weight: { type: Number, required: true },
  weightUnit: { type: String, enum: ['kg', 'lbs'], default: 'lbs' },
  length: { type: Number, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  dimensionUnit: { type: String, enum: ['cm', 'in'], default: 'in' },
  description: { type: String, required: true },
  declaredValue: { type: Number },
  insuranceAmount: { type: Number, default: 0 },
  specialHandling: { type: Boolean, default: false },
  quantity: { type: Number, default: 1 },
});

const RateSchema = new Schema<IRate>({
  carrierId: { type: String, required: true },
  carrierName: { type: String, required: true },
  serviceCode: { type: String, required: true },
  serviceName: { type: String, required: true },
  totalCharge: { type: Number, required: true },
  currency: { type: String, default: 'CAD' },
  transitDays: { type: Number },
  estimatedDelivery: { type: String },
  isCheapest: { type: Boolean },
  isFastest: { type: Boolean },
  isBestValue: { type: Boolean },
});

const PickupDetailsSchema = new Schema<IPickupDetails>({
  method: { type: String, enum: ['schedule_pickup', 'drop_off'], default: 'drop_off' },
  location: { type: String },
  instructions: { type: String },
  pickupDate: { type: String },
  readyHour: { type: String },
  readyMin: { type: String },
  closeHour: { type: String },
  closeMin: { type: String },
}, { _id: false });

const SpecialServicesSchema = new Schema<ISpecialServices>({
  saturdayDelivery: { type: Boolean, default: false },
  signatureRequired: { type: Boolean, default: false },
  adultSignature: { type: Boolean, default: false },
  holdForPickup: { type: Boolean, default: false },
  insidePickup: { type: Boolean, default: false },
  insideDelivery: { type: Boolean, default: false },
  tailgatePickup: { type: Boolean, default: false },
  tailgateDelivery: { type: Boolean, default: false },
}, { _id: false });

const ReferenceSchema = new Schema<IReference>({
  referenceName: { type: String },
  referenceValue: { type: String },
}, { _id: false });

const ShipmentSchema = new Schema<IShipment>(
  {
    shipmentNumber: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    guestEmail: { type: String },
    guestPhone: { type: String },
    shipper: { type: AddressSchema, required: true },
    recipient: { type: AddressSchema, required: true },
    parcels: [ParcelSchema],
    shipmentType: { type: String, enum: ['domestic', 'international'], required: true },
    selectedRate: { type: RateSchema, required: true },
    allRates: [RateSchema],
    pickupDetails: { type: PickupDetailsSchema },
    specialServices: { type: SpecialServicesSchema },
    references: [ReferenceSchema],
    status: {
      type: String,
      enum: [
        'quote', 'pending_payment', 'paid', 'label_generated',
        'pickup_scheduled', 'in_transit', 'out_for_delivery',
        'delivered', 'cancelled', 'refund_requested', 'refunded',
      ],
      default: 'quote',
    },
    trackingNumber: { type: String },
    labelUrl: { type: String },
    labelBase64: { type: String },
    netparcelOrderId: { type: Number },
    payment: {
      method: { type: String, enum: ['stripe', 'paypal', 'wise', 'remitly'] },
      status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
      transactionId: { type: String },
      amount: { type: Number },
      currency: { type: String, default: 'CAD' },
      paidAt: { type: Date },
    },
    cancellation: {
      requestedAt: { type: Date },
      reason: { type: String },
      refundAmount: { type: Number },
      processedAt: { type: Date },
      notes: { type: String },
    },
    statusHistory: [
      {
        status: { type: String },
        timestamp: { type: Date, default: Date.now },
        note: { type: String },
      },
    ],
    adminNotes: { type: String },
    manualPriceOverride: { type: Number },
  },
  { timestamps: true }
);

ShipmentSchema.pre('save', function (next) {
  if (this.isModified('status')) {
    this.statusHistory.push({ status: this.status, timestamp: new Date() });
  }
  next();
});

export default mongoose.model<IShipment>('Shipment', ShipmentSchema);
