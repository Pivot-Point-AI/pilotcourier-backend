import { Request, Response, NextFunction } from 'express';
import PDFDocument from 'pdfkit';
import { ownedShipment, requestError } from '../utils/shipment-access';

export const downloadInvoice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shipment = await ownedShipment(req, req.params.id);
    if (!['completed', 'refunded'].includes(shipment.payment.status)) throw requestError(409, 'Invoice is available after payment.');
    const invoiceNumber = `NPI${String(shipment.netparcelOrderId || parseInt(String(shipment._id).slice(-7), 16) % 9999999).padStart(6, '0')}`;
    const doc = new PDFDocument({ margin: 50, info: { Title: `Invoice ${invoiceNumber}`, Author: 'Pilot Courier' } });
    const chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    doc.fontSize(22).text('Pilot Courier');
    doc.fontSize(16).text(`Invoice ${invoiceNumber}`).moveDown();
    doc.fontSize(10).text(`Shipment: ${shipment.shipmentNumber}`);
    doc.text(`Date: ${(shipment.payment.paidAt || shipment.createdAt).toISOString().slice(0, 10)}`);
    doc.text(`Payment status: ${shipment.payment.status}`).moveDown();
    for (const [label, address] of [['Shipper', shipment.shipper], ['Recipient', shipment.recipient]] as const) {
      doc.font('Helvetica-Bold').text(label).font('Helvetica');
      doc.text([address.name, address.company, address.street, address.street2,
        `${address.city}, ${address.province} ${address.postalCode}`, address.country].filter(Boolean).join('\n')).moveDown();
    }
    doc.text(`Service: ${shipment.selectedRate.serviceName}`);
    doc.text(`Packages: ${shipment.parcels.length}`).moveDown();
    doc.font('Helvetica-Bold').fontSize(14).text(`Total charged: ${shipment.payment.currency} ${shipment.payment.amount.toFixed(2)}`);
    doc.font('Helvetica').fontSize(9).moveDown().text('Tax and surcharge breakdown is not separately itemized in this invoice.');
    doc.end();
    const pdf = await finished;
    res.json({ success: true, invoiceNumber, invoice: `data:application/pdf;base64,${pdf.toString('base64')}` });
  } catch (error) { next(error); }
};
