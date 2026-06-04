import nodemailer from 'nodemailer';
import logger from '../utils/logger';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string | Buffer;
    encoding?: string;
    contentType?: string;
  }>;
}

class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  private getBaseTemplate(content: string, title: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f7fb; }
        .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
        .header { background: linear-gradient(135deg, #0c2461 0%, #1e3a8a 100%); padding: 32px; text-align: center; }
        .header-logo { color: #fff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
        .header-logo span { color: #f97316; }
        .header-tag { color: rgba(255,255,255,0.7); font-size: 13px; margin-top: 4px; }
        .body { padding: 40px 32px; }
        .greeting { font-size: 22px; font-weight: 700; color: #0c2461; margin-bottom: 12px; }
        .text { color: #475569; font-size: 15px; line-height: 1.7; margin-bottom: 16px; }
        .card { background: #f8faff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin: 24px 0; }
        .card-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
        .card-row:last-child { border-bottom: none; font-weight: 700; color: #0c2461; }
        .card-label { color: #64748b; font-size: 14px; }
        .card-value { color: #1e293b; font-size: 14px; font-weight: 600; text-align: right; }
        .btn { display: inline-block; background: #f97316; color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 15px; margin: 20px 0; }
        .divider { height: 1px; background: #e2e8f0; margin: 24px 0; }
        .footer { background: #0c2461; padding: 24px 32px; text-align: center; }
        .footer p { color: rgba(255,255,255,0.6); font-size: 13px; line-height: 1.6; }
        .footer a { color: #f97316; text-decoration: none; }
        .status-badge { display: inline-block; background: #dcfce7; color: #16a34a; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
        .warning-badge { display: inline-block; background: #fef3c7; color: #d97706; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="header-logo">PILOT <span>COURIER</span></div>
          <div class="header-tag">Ship Smarter. Pay Less.</div>
        </div>
        <div class="body">
          ${content}
        </div>
        <div class="footer">
          <p>© 2024 Pilot Courier. All rights reserved.<br>
          <a href="${process.env.FRONTEND_URL}">www.pilotcourier.com</a> | 
          <a href="mailto:support@pilotcourier.com">support@pilotcourier.com</a></p>
        </div>
      </div>
    </body>
    </html>`;
  }

  async sendBookingConfirmation(email: string, shipment: any, phone?: string): Promise<void> {
    const content = `
      <div class="greeting">Your shipment is confirmed! ✅</div>
      <p class="text">Thank you for choosing Pilot Courier. Your shipment has been booked and your label is ready.</p>
      
      <div class="card">
        <div class="card-row">
          <span class="card-label">Shipment Number</span>
          <span class="card-value">${shipment.shipmentNumber}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Tracking Number</span>
          <span class="card-value">${shipment.trackingNumber || 'Pending'}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Carrier</span>
          <span class="card-value">${shipment.selectedRate.carrierName} — ${shipment.selectedRate.serviceName}</span>
        </div>
        <div class="card-row">
          <span class="card-label">From</span>
          <span class="card-value">${shipment.shipper.city}, ${shipment.shipper.province}</span>
        </div>
        <div class="card-row">
          <span class="card-label">To</span>
          <span class="card-value">${shipment.recipient.city}, ${shipment.recipient.province}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Est. Delivery</span>
          <span class="card-value">${shipment.selectedRate.estimatedDelivery || `${shipment.selectedRate.transitDays} business days`}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Total Paid</span>
          <span class="card-value">$${shipment.payment.amount?.toFixed(2)} ${shipment.payment.currency}</span>
        </div>
      </div>

      <a href="${process.env.FRONTEND_URL}/track?number=${shipment.trackingNumber}" class="btn">Track Your Shipment</a>
      
      <div class="divider"></div>
      <p class="text"><strong>Cancellation Policy:</strong> Full refund if cancelled same day and documents unused. After 24 hours or pickup, written request required. $25 fee if cancelled on driver arrival.</p>
    `;

    const attachments = shipment.labelBase64
      ? [{ filename: `label-${shipment.shipmentNumber}.pdf`, content: shipment.labelBase64, encoding: 'base64', contentType: 'application/pdf' }]
      : [];

    await this.send({
      to: email,
      subject: `✅ Shipment Confirmed — ${shipment.shipmentNumber} | Pilot Courier`,
      html: this.getBaseTemplate(content, 'Booking Confirmation'),
      attachments,
    });

    if (phone) {
      logger.info(`SMS notification would be sent to ${phone} for shipment ${shipment.shipmentNumber}`);
    }
  }

  async sendCancellationConfirmation(email: string, shipment: any, refundAmount: number): Promise<void> {
    const content = `
      <div class="greeting">Shipment Cancellation Confirmed</div>
      <p class="text">Your shipment <strong>${shipment.shipmentNumber}</strong> has been successfully cancelled.</p>
      
      <div class="card">
        <div class="card-row">
          <span class="card-label">Shipment Number</span>
          <span class="card-value">${shipment.shipmentNumber}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Refund Amount</span>
          <span class="card-value">$${refundAmount.toFixed(2)} CAD</span>
        </div>
        <div class="card-row">
          <span class="card-label">Refund Timeline</span>
          <span class="card-value">3–5 business days</span>
        </div>
        <div class="card-row">
          <span class="card-label">Status</span>
          <span class="card-value"><span class="warning-badge">Refund Processing</span></span>
        </div>
      </div>

      <p class="text">If you have questions, please contact us at <a href="mailto:support@pilotcourier.com">support@pilotcourier.com</a>.</p>
    `;

    await this.send({
      to: email,
      subject: `Shipment Cancelled — ${shipment.shipmentNumber} | Pilot Courier`,
      html: this.getBaseTemplate(content, 'Cancellation Confirmation'),
    });
  }

  async sendStatusUpdate(email: string, shipment: any, status: string): Promise<void> {
    const statusMessages: Record<string, string> = {
      in_transit: '📦 Your shipment is on its way!',
      out_for_delivery: '🚚 Out for delivery today!',
      delivered: '✅ Your shipment has been delivered!',
      pickup_scheduled: '📅 Pickup has been scheduled.',
    };

    const content = `
      <div class="greeting">${statusMessages[status] || 'Shipment Update'}</div>
      <p class="text">There's an update on your shipment <strong>${shipment.shipmentNumber}</strong>.</p>
      
      <div class="card">
        <div class="card-row">
          <span class="card-label">Tracking Number</span>
          <span class="card-value">${shipment.trackingNumber}</span>
        </div>
        <div class="card-row">
          <span class="card-label">Current Status</span>
          <span class="card-value"><span class="status-badge">${status.replace(/_/g, ' ').toUpperCase()}</span></span>
        </div>
        <div class="card-row">
          <span class="card-label">Carrier</span>
          <span class="card-value">${shipment.selectedRate.carrierName}</span>
        </div>
      </div>

      <a href="${process.env.FRONTEND_URL}/track?number=${shipment.trackingNumber}" class="btn">View Tracking Details</a>
    `;

    await this.send({
      to: email,
      subject: `${statusMessages[status] || 'Update'} — ${shipment.shipmentNumber}`,
      html: this.getBaseTemplate(content, 'Shipment Update'),
    });
  }

  async sendWelcomeEmail(email: string, firstName: string): Promise<void> {
    const content = `
      <div class="greeting">Welcome to Pilot Courier, ${firstName}! 🎉</div>
      <p class="text">Your account has been created successfully. You can now access real-time rates from top carriers, book shipments, and track your packages — all in one place.</p>
      
      <a href="${process.env.FRONTEND_URL}/quote" class="btn">Get Your First Quote</a>

      <div class="divider"></div>
      <p class="text">Need help? Our team is available at <a href="mailto:support@pilotcourier.com">support@pilotcourier.com</a>.</p>
    `;

    await this.send({
      to: email,
      subject: 'Welcome to Pilot Courier — Start Saving on Shipping!',
      html: this.getBaseTemplate(content, 'Welcome'),
    });
  }

  private async send(options: EmailOptions): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: `"Pilot Courier" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
        to: options.to,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments,
      });
      logger.info(`Email sent to ${options.to}: ${options.subject}`);
    } catch (error) {
      logger.error(`Failed to send email to ${options.to}:`, error);
    }
  }
}

export default new EmailService();
