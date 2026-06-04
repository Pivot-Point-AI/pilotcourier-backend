import { Request, Response, NextFunction } from 'express';
import Shipment from '../models/Shipment';
import User from '../models/User';
import emailService from '../services/email.service';

// GET /api/admin/shipments
export const getAllShipments = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query;

    const query: any = {};
    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { shipmentNumber: { $regex: search, $options: 'i' } },
        { trackingNumber: { $regex: search, $options: 'i' } },
        { guestEmail: { $regex: search, $options: 'i' } },
        { 'shipper.name': { $regex: search, $options: 'i' } },
        { 'recipient.name': { $regex: search, $options: 'i' } },
      ];
    }

    const shipments = await Shipment.find(query)
      .populate('userId', 'firstName lastName email phone')
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

// GET /api/admin/dashboard
export const getDashboardStats = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalShipments,
      todayShipments,
      totalRevenue,
      activeShipments,
      totalUsers,
      statusBreakdown,
    ] = await Promise.all([
      Shipment.countDocuments(),
      Shipment.countDocuments({ createdAt: { $gte: today } }),
      Shipment.aggregate([
        { $match: { 'payment.status': 'completed' } },
        { $group: { _id: null, total: { $sum: '$payment.amount' } } },
      ]),
      Shipment.countDocuments({ status: { $in: ['paid', 'label_generated', 'pickup_scheduled', 'in_transit', 'out_for_delivery'] } }),
      User.countDocuments({ role: 'customer' }),
      Shipment.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    ]);

    res.json({
      success: true,
      stats: {
        totalShipments,
        todayShipments,
        totalRevenue: totalRevenue[0]?.total || 0,
        activeShipments,
        totalUsers,
        statusBreakdown: statusBreakdown.reduce((acc: any, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/shipments/:id/status
export const updateShipmentStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { status, note } = req.body;

    const shipment = await Shipment.findByIdAndUpdate(
      id,
      {
        status,
        $push: { statusHistory: { status, timestamp: new Date(), note } },
      },
      { new: true }
    );

    if (!shipment) return res.status(404).json({ success: false, message: 'Shipment not found.' });

    const contactEmail = shipment.guestEmail || '';
    const notifiableStatuses = ['in_transit', 'out_for_delivery', 'delivered', 'pickup_scheduled'];
    if (contactEmail && notifiableStatuses.includes(status)) {
      await emailService.sendStatusUpdate(contactEmail, shipment, status);
    }

    res.json({ success: true, message: 'Status updated.', shipment });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/admin/shipments/:id/price-override
export const overridePrice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { price, note } = req.body;

    const shipment = await Shipment.findByIdAndUpdate(
      id,
      { manualPriceOverride: price, adminNotes: note },
      { new: true }
    );

    res.json({ success: true, message: 'Price overridden.', shipment });
  } catch (error) {
    next(error);
  }
};

// GET /api/admin/users
export const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const query: any = { role: 'customer' };
    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip((+page - 1) * +limit)
      .limit(+limit)
      .lean();

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: { page: +page, limit: +limit, total, pages: Math.ceil(total / +limit) },
    });
  } catch (error) {
    next(error);
  }
};
