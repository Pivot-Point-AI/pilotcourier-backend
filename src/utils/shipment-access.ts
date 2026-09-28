import { Request } from 'express';
import Shipment from '../models/Shipment';

export function requestError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export async function ownedShipment(req: Request, id: unknown) {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw requestError(400, 'Invalid shipment ID.');
  const userId = (req as any).user?.userId;
  if (!userId) throw requestError(401, 'Authentication required.');
  const shipment = await Shipment.findById(id);
  if (!shipment) throw requestError(404, 'Shipment not found.');
  if (!shipment.userId || String(shipment.userId) !== userId) throw requestError(403, 'Unauthorized.');
  return shipment;
}
