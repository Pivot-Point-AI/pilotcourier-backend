import { Request, Response, NextFunction } from 'express';
import NewsletterSubscriber from '../models/NewsletterSubscriber';
import emailService from '../services/email.service';
import { requestError } from '../utils/shipment-access';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// People never see the hidden "website" field; bots fill it. Answer as if it worked so bots don't adapt.
const isBot = (body: any): boolean => typeof body?.website === 'string' && body.website.trim() !== '';

// ── POST /api/contact ────────────────────────────────────────────────────────
export const submitContact = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (isBot(req.body)) return res.json({ success: true, message: 'Message sent.' });

    const name = text(req.body?.name, 100);
    const email = text(req.body?.email, 254);
    const subject = text(req.body?.subject, 150).replace(/[\r\n]+/g, ' ');
    const message = text(req.body?.message, 5000);
    if (!name || !subject || !message) throw requestError(400, 'Please fill in your name, subject and message.');
    if (!EMAIL_RE.test(email)) throw requestError(400, 'Please enter a valid email address.');

    try {
      await emailService.sendContactMessage({ name, email, subject, message });
    } catch {
      return res.status(502).json({ success: false,
        message: 'Your message could not be sent. Please try again later or email support@pilotcourier.com.' });
    }
    res.json({ success: true, message: 'Message sent.' });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/newsletter/subscribe ───────────────────────────────────────────
export const subscribeNewsletter = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (isBot(req.body)) return res.json({ success: true, message: 'Subscribed.' });

    const email = text(req.body?.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) throw requestError(400, 'Please enter a valid email address.');

    // Same answer for new and existing subscribers, so the form never reveals who is on the list
    try {
      await NewsletterSubscriber.updateOne({ email }, { $setOnInsert: { email, source: 'footer' } }, { upsert: true });
    } catch (error: any) {
      if (error?.code !== 11000) throw error; // concurrent duplicate insert: already subscribed
    }
    res.json({ success: true, message: 'Subscribed.' });
  } catch (error) {
    next(error);
  }
};
