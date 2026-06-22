import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface ISavedPackage {
  _id?: any;
  name: string;
  description: string;
  length: number;
  width: number;
  height: number;
  weight: number;
  dimensionUnit: 'cm' | 'in';
  weightUnit: 'kg' | 'lbs';
  specialHandling: boolean;
}

export interface ISavedProduct {
  _id?: any;
  productName: string;
  productCode: string;
  description: string;
  harmonizedCode: string;
  unitPrice: number;
  originCountry: string;
}

export interface ITicket {
  _id?: any;
  subject: string;
  type: string;
  message: string;
  orderNumber?: string;
  status: 'open' | 'in_progress' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

export interface IUser extends Document {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  role: 'customer' | 'admin';
  isActive: boolean;
  emailVerified: boolean;
  company?: string;
  address?: {
    street: string;
    city: string;
    province: string;
    postalCode: string;
    country: string;
  };
  savedAddresses: Array<{
    _id?: any;
    label: string;
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
    isDefault: boolean;
  }>;
  savedPackages: ISavedPackage[];
  savedProducts: ISavedProduct[];
  tickets: ITicket[];
  resetPasswordToken?: string;
  resetPasswordExpires?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  fullName: string;
}

const AddressSchema = new Schema({
  label: { type: String, default: 'Home' },
  name: { type: String, required: true },
  company: { type: String },
  street: { type: String, required: true },
  street2: { type: String },
  city: { type: String, required: true },
  province: { type: String, required: true },
  postalCode: { type: String, required: true },
  country: { type: String, required: true, default: 'CA' },
  phone: { type: String, required: true },
  email: { type: String },
  isDefault: { type: Boolean, default: false },
});

const SavedPackageSchema = new Schema({
  name: { type: String, required: true },
  description: { type: String },
  length: { type: Number, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  weight: { type: Number, required: true },
  dimensionUnit: { type: String, enum: ['cm', 'in'], default: 'in' },
  weightUnit: { type: String, enum: ['kg', 'lbs'], default: 'lbs' },
  specialHandling: { type: Boolean, default: false },
}, { timestamps: true });

const SavedProductSchema = new Schema({
  productName: { type: String, required: true },
  productCode: { type: String, required: true },
  description: { type: String },
  harmonizedCode: { type: String },
  unitPrice: { type: Number, default: 0 },
  originCountry: { type: String, default: 'CA' },
}, { timestamps: true });

const TicketSchema = new Schema({
  subject: { type: String, required: true },
  type: { type: String, default: 'general' },
  message: { type: String, required: true },
  orderNumber: { type: String },
  status: { type: String, enum: ['open', 'in_progress', 'closed'], default: 'open' },
}, { timestamps: true });

const UserSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String, required: true, unique: true,
      lowercase: true, trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },
    phone: { type: String, required: true, trim: true },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    isActive: { type: Boolean, default: true },
    emailVerified: { type: Boolean, default: false },
    company: { type: String },
    address: {
      street: { type: String },
      city: { type: String },
      province: { type: String },
      postalCode: { type: String },
      country: { type: String, default: 'CA' },
    },
    savedAddresses: [AddressSchema],
    savedPackages: [SavedPackageSchema],
    savedProducts: [SavedProductSchema],
    tickets: [TicketSchema],
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

UserSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model<IUser>('User', UserSchema);
