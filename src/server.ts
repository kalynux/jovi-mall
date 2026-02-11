import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { app } from './app';
import { initAggregationScheduler } from './core/jobs/aggregation-scheduler';

dotenv.config();

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

async function startServer() {
  try {
    // Database Connection
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Initialize scheduled jobs
    initAggregationScheduler();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
