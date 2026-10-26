const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const http = require("http");
const WebSocket = require("ws");

dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;
const MONGO_URI = process.env.MONGO_URI;

// ===============================
// MongoDB Connection
// ===============================

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected successfully");
  })
  .catch((error) => {
    console.error("❌ MongoDB connection failed:", error.message);
  });

// ===============================
// Token Schema
// ===============================

const tokenSchema = new mongoose.Schema({
  tokenNumber: {
    type: String,
    required: true,
    unique: true,
  },

  customerName: {
    type: String,
    required: true,
  },

  service: {
    type: String,
    required: true,
  },

  serviceDuration: {
    type: Number,
    default: 5,
  },

  estimatedWait: {
    type: Number,
    default: 0,
  },

  status: {
    type: String,
    enum: ["waiting", "serving", "completed"],
    default: "waiting",
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Token = mongoose.model("Token", tokenSchema);

// ===============================
// Service Durations
// ===============================

const serviceDurations = {
  "General Service": 7,
  "Document Verification": 10,
  "Payment Service": 5,
  Enquiry: 4,
};

// ===============================
// WebSocket Setup
// ===============================

const wss = new WebSocket.Server({
  server,
  path: "/ws",
});

function broadcastQueueUpdate() {
  const message = JSON.stringify({
    type: "QUEUE_UPDATED",
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("🔌 Frontend connected through WebSocket");

  ws.send(
    JSON.stringify({
      type: "CONNECTED",
    })
  );

  ws.on("close", () => {
    console.log("🔌 Frontend WebSocket disconnected");
  });
});

// ===============================
// Helper Functions
// ===============================

function formatToken(token) {
  return {
    id: token._id.toString(),
    token_number: token.tokenNumber,
    customer_name: token.customerName,
    service: token.service,
    service_duration: token.serviceDuration,
    estimated_wait: token.estimatedWait,
    status: token.status,
    created_at: token.createdAt,
  };
}

async function recalculateWaitingTimes() {
  const tokens = await Token.find({
    status: { $in: ["waiting", "serving"] },
  }).sort({ createdAt: 1 });

  let currentWait = 0;

  for (const token of tokens) {
    if (token.status === "serving") {
      token.estimatedWait = 0;
      await token.save();

      currentWait = token.serviceDuration;
    } else {
      token.estimatedWait = currentWait;
      await token.save();

      currentWait += token.serviceDuration;
    }
  }
}

// ===============================
// Health Check
// ===============================

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Smart Queue backend is running",
  });
});

// ===============================
// Get All Tokens
// ===============================

app.get("/tokens", async (req, res) => {
  try {
    await recalculateWaitingTimes();

    const tokens = await Token.find().sort({ createdAt: 1 });

    res.json(tokens.map(formatToken));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to fetch queue",
    });
  }
});

// ===============================
// Get Single Token
// ===============================

app.get("/tokens/:token_number", async (req, res) => {
  try {
    const token = await Token.findOne({
      tokenNumber: req.params.token_number,
    });

    if (!token) {
      return res.status(404).json({
        error: "Token not found",
      });
    }

    res.json(formatToken(token));
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch token",
    });
  }
});

// ===============================
// Generate New Token
// ===============================

app.post("/tokens", async (req, res) => {
  try {
    const { customer_name, service } = req.body;

    if (!customer_name || !service) {
      return res.status(400).json({
        error: "Customer name and service are required",
      });
    }

    const duration = serviceDurations[service] || 5;

    // Find highest existing token number
    const existingTokens = await Token.find()
      .select("tokenNumber")
      .lean();

    let maxNumber = 100;

    for (const item of existingTokens) {
      const match = item.tokenNumber?.match(/(\d+)$/);

      if (match) {
        maxNumber = Math.max(maxNumber, Number(match[1]));
      }
    }

    const tokenNumber = `A-${maxNumber + 1}`;

    const token = new Token({
      tokenNumber,
      customerName: customer_name,
      service,
      serviceDuration: duration,
      estimatedWait: 0,
      status: "waiting",
    });

    await token.save();

    await recalculateWaitingTimes();

    const updatedToken = await Token.findById(token._id);

    broadcastQueueUpdate();

    res.status(201).json(formatToken(updatedToken));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to generate token",
    });
  }
});

// ===============================
// Serve Token
// ===============================

app.put("/tokens/:token_number/serve", async (req, res) => {
  try {
    const token = await Token.findOne({
      tokenNumber: req.params.token_number,
    });

    if (!token) {
      return res.status(404).json({
        error: "Token not found",
      });
    }

    token.status = "serving";
    token.estimatedWait = 0;

    await token.save();

    await recalculateWaitingTimes();

    const updatedToken = await Token.findById(token._id);

    broadcastQueueUpdate();

    res.json(formatToken(updatedToken));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to serve token",
    });
  }
});

// ===============================
// Complete Token
// ===============================

app.put("/tokens/:token_number/complete", async (req, res) => {
  try {
    const token = await Token.findOne({
      tokenNumber: req.params.token_number,
    });

    if (!token) {
      return res.status(404).json({
        error: "Token not found",
      });
    }

    token.status = "completed";
    token.estimatedWait = 0;

    await token.save();

    await recalculateWaitingTimes();

    const updatedToken = await Token.findById(token._id);

    broadcastQueueUpdate();

    res.json(formatToken(updatedToken));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to complete token",
    });
  }
});

// ===============================
// Start Server
// ===============================

server.listen(PORT, () => {
  console.log(`🚀 Smart Queue server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket running on ws://localhost:${PORT}/ws`);
});