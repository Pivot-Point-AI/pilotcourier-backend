import mongoose from 'mongoose';
import logger from '../utils/logger';

const connectDB = async (): Promise<void> => {
  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://pilotcourier:goag4S44Q2zFJhRJ@ac-fqcm2vp-shard-00-00.ndlrea4.mongodb.net:27017,ac-fqcm2vp-shard-00-01.ndlrea4.mongodb.net:27017,ac-fqcm2vp-shard-00-02.ndlrea4.mongodb.net:27017/?ssl=true&replicaSet=atlas-yrtuxq-shard-0&authSource=admin&appName=pilotcourier';
    
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    logger.info(`MongoDB Connected: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB connection error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected. Attempting reconnect...');
    });

  } catch (error) {
    logger.error(`Database connection failed: ${error}`);
    process.exit(1);
  }
};

export default connectDB;
