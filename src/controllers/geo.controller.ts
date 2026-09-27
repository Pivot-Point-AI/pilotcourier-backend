import { Request, Response } from 'express';
import { lookupPostal } from '../services/postal.service';

export async function getPostal(req: Request, res: Response) {
  const { country, postal } = req.query;
  if (typeof country !== 'string' || typeof postal !== 'string' ||
      !/^[A-Za-z]{2}$/.test(country.trim()) || !postal.trim() || postal.length > 32) {
    return res.status(400).json({ error: 'Valid country and postal required' });
  }
  try {
    return res.json(await lookupPostal(country, postal));
  } catch {
    return res.json({ city: '', province: '' });
  }
}
