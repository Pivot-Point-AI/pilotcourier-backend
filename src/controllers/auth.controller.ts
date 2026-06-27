import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User';
import SavedQuote from '../models/SavedQuote';
import emailService from '../services/email.service';
import logger from '../utils/logger';

const generateToken = (userId: string, role: string): string => {
  return jwt.sign(
    { userId, role },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as any
  );
};


export const register = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, email, phone, password } = req.body;

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    const user = await User.create({ firstName, lastName, email, phone, password });
    const token = generateToken(user._id.toString(), user.role);

    await emailService.sendWelcomeEmail(email, firstName);

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Please contact support.' });
    }

    const token = generateToken(user._id.toString(), user.role);

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    const genericResponse = {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    };

    const user = await User.findOne({ email });
    if (!user) return res.json(genericResponse);

    const rawToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${rawToken}`;
    await emailService.sendPasswordResetEmail(user.email, user.firstName, resetUrl);

    res.json(genericResponse);
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/reset-password ────────────────────────────────────────────
export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: new Date() },
    }).select('+resetPasswordToken +resetPasswordExpires');

    if (!user) {
      return res.status(400).json({ success: false, message: 'This reset link is invalid or has expired.' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ success: true, message: 'Your password has been reset successfully. You can now sign in.' });
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    res.json({
      success: true,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        savedAddresses: user.savedAddresses,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, phone } = req.body;
    const user = await User.findByIdAndUpdate(
      (req as any).user.userId,
      { firstName, lastName, phone },
      { new: true, runValidators: true }
    );

    res.json({ success: true, message: 'Profile updated.', user });
  } catch (error) {
    next(error);
  }
};

export const addSavedAddress = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    if (req.body.isDefault) {
      user.savedAddresses.forEach((addr) => (addr.isDefault = false));
    }

    user.savedAddresses.push(req.body);
    await user.save();

    res.json({ success: true, message: 'Address saved.', addresses: user.savedAddresses });
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/auth/addresses/:addressId ────────────────────────────────────
export const deleteSavedAddress = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.savedAddresses = user.savedAddresses.filter(
      (a: any) => a._id.toString() !== req.params.addressId
    );
    await user.save();
    res.json({ success: true, message: 'Address removed.', addresses: user.savedAddresses });
  } catch (error) { next(error); }
};

// ── Packages ─────────────────────────────────────────────────────────────────
export const getPackages = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    res.json({ success: true, packages: user?.savedPackages || [] });
  } catch (error) { next(error); }
};

export const addPackage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.savedPackages.push(req.body);
    await user.save();
    res.json({ success: true, message: 'Package saved.', packages: user.savedPackages });
  } catch (error) { next(error); }
};

export const deletePackage = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.savedPackages = user.savedPackages.filter(
      (p: any) => p._id.toString() !== req.params.packageId
    );
    await user.save();
    res.json({ success: true, message: 'Package removed.', packages: user.savedPackages });
  } catch (error) { next(error); }
};

// ── Products ──────────────────────────────────────────────────────────────────
export const getProducts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    res.json({ success: true, products: user?.savedProducts || [] });
  } catch (error) { next(error); }
};

export const addProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.savedProducts.push(req.body);
    await user.save();
    res.json({ success: true, message: 'Product saved.', products: user.savedProducts });
  } catch (error) { next(error); }
};

export const deleteProduct = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.savedProducts = user.savedProducts.filter(
      (p: any) => p._id.toString() !== req.params.productId
    );
    await user.save();
    res.json({ success: true, message: 'Product removed.', products: user.savedProducts });
  } catch (error) { next(error); }
};

// ── Tickets ───────────────────────────────────────────────────────────────────
export const getTickets = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    res.json({ success: true, tickets: user?.tickets || [] });
  } catch (error) { next(error); }
};

export const createTicket = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await User.findById((req as any).user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.tickets.push({ ...req.body, status: 'open' } as any);
    await user.save();
    res.json({ success: true, message: 'Ticket submitted.', tickets: user.tickets });
  } catch (error) { next(error); }
};

// ── Saved Quotes ──────────────────────────────────────────────────────────────
export const getSavedQuotes = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);
    const filter = { user: (req as any).user.userId };

    const [quotes, total] = await Promise.all([
      SavedQuote.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SavedQuote.countDocuments(filter),
    ]);

    res.json({
      success: true,
      quotes,
      pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) },
    });
  } catch (error) { next(error); }
};

export const deleteSavedQuote = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await SavedQuote.deleteOne({ _id: req.params.quoteId, user: (req as any).user.userId });
    res.json({ success: true, message: 'Quote removed.' });
  } catch (error) { next(error); }
};

// ── Update full profile (incl. company + address) ───────────────────────────
export const updateFullProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { firstName, lastName, phone, company, address } = req.body;
    const user = await User.findByIdAndUpdate(
      (req as any).user.userId,
      { firstName, lastName, phone, company, address },
      { new: true, runValidators: true }
    );
    res.json({ success: true, message: 'Profile updated.', user });
  } catch (error) { next(error); }
};
