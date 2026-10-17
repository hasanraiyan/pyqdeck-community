import mongoose from "mongoose";

export class HealthService {
  check() {
    const dbConnected = mongoose.connection.readyState === mongoose.ConnectionStates.connected;
    return {
      status: dbConnected ? "ok" : "degraded",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbConnected ? "connected" : "disconnected",
    };
  }
}
