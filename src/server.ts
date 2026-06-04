import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import connectDB from './config/database';
import routes from './routes';
import { notFound, errorHandler } from './middleware/error.middleware';
import logger from './utils/logger';

const app = express();

// ── Security ────────────────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  'http://localhost:3000',
  'https://pilotcourier.com',
  'https://www.pilotcourier.com',
  'https://pilot-courier.vercel.app',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
];

app.use(cors({
  origin: (origin, callback) => {
    // allow server-to-server / curl with no origin
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});
app.use('/api/', limiter);

// ── Stripe webhook needs raw body ───────────────────────────────────────────
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));

// ── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (message: string) => logger.http(message.trim()) },
  }));
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 & Error Handlers ─────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ── Bootstrap ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    logger.info(`🚀 Pilot Courier API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
};

start().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

export default app;
