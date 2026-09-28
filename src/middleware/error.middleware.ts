import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export interface AppError extends Error {
  statusCode?: number;
  status?: string;
  isOperational?: boolean;
}

export const notFound = (req: Request, res: Response, next: NextFunction) => {
  const error: AppError = new Error(`Route not found: ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

export const errorHandler = (err: AppError, req: Request, res: Response, _next: NextFunction) => {
  const statusCode = err.name === 'CastError' ? 400 : err.statusCode || 500;

  if (statusCode === 500) {
    logger.error(`[${req.method}] ${req.path} - ${err.message}`, { stack: err.stack });
  }

  res.status(statusCode).json({
    success: false,
    message: err.name === 'CastError' ? 'Invalid identifier.'
      : statusCode >= 500 ? 'An unexpected error occurred. Please try again.'
      : err.message || 'Request failed.',
  });
};
