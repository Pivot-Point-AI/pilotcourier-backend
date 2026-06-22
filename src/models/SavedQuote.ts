import mongoose, { Document, Schema } from 'mongoose';

export interface ISavedQuote extends Document {
  user: mongoose.Types.ObjectId;
  type: 'quick' | 'detailed';
  signature: string;
  formData: any;
  rates: any[];
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SavedQuoteSchema = new Schema<ISavedQuote>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['quick', 'detailed'], required: true },
    signature: { type: String, required: true },
    formData: { type: Schema.Types.Mixed, required: true },
    rates: { type: Schema.Types.Mixed, default: [] },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Same user + type + identical inputs → one record, refreshed in place instead of duplicated
SavedQuoteSchema.index({ user: 1, type: 1, signature: 1 }, { unique: true });

// Mongo TTL index — document is auto-removed once expiresAt passes
SavedQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<ISavedQuote>('SavedQuote', SavedQuoteSchema);
