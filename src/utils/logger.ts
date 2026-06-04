import winston from 'winston';

const { combine, timestamp, errors, json, colorize, simple } = winston.format;

const isVercel = !!process.env.VERCEL;

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production'
      ? combine(timestamp(), errors({ stack: true }), json())
      : combine(colorize(), simple()),
  }),
];

if (!isVercel && process.env.NODE_ENV !== 'production') {
  const fs = require('fs');
  if (!fs.existsSync('logs')) fs.mkdirSync('logs');
  transports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), json()),
  transports,
});

export default logger;
