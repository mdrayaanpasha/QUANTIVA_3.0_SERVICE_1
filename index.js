import express from "express";
import cors from "cors";
import yahooFinance from "yahoo-finance2";
import { createClient } from 'redis';
import dotenv from "dotenv";
import amqplib from "amqplib";

dotenv.config();

const client = createClient({
  url: process.env.REDIS_KEY
});
await client.connect();
const rabbitmqUrl = process.env.RABITMQ_KEY;


async function connectRabbitMQ() {
  try {
    const connection = await amqplib.connect(rabbitmqUrl);
    channel = await connection.createChannel();
    console.log("Connected to RabbitMQ");
  } catch (error) {
    console.error("Failed to connect to RabbitMQ:", error);
  }
}


let Queue = "main_queue";
const responseQueue = "response_queue";

let conn = await amqplib.connect(rabbitmqUrl);
let channel = await conn.createChannel();

await channel.assertQueue(responseQueue, { durable: false });
await channel.assertQueue(Queue, { durable: true });
await channel.assertExchange("amq.direct", "direct", { durable: true });

await channel.consume(Queue, (msg) => {
  if (msg !== null) {
    console.log("Received message:", msg.content.toString());
    channel.ack(msg);
  }
}, { noAck: false }); 


const pending = new Map();

channel.consume(responseQueue, (msg) => {
  const id = msg.properties.correlationId;
  const req = pending.get(id);
  if (!req) return channel.ack(msg);
  req.collected.push(JSON.parse(msg.content.toString()));
  channel.ack(msg);
  if (req.collected.length === 3) {
    req.resolve(req.collected);
    pending.delete(id);
  }
}, { noAck: false });


client.on('error', err => console.log('Redis Client Error', err));



const app = express();
const PORT = process.env.PORT || 3000;
const yf = new yahooFinance();

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Server is running" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});


app.post("/initiate-company-analysis",async(req,res)=>{
  const {ticker, startDate, endDate} = req.body;

  try {

    const senderQueue = ["ema_queue", "rsi_queue", "sma_queue"];
    const key = `${ticker}:${startDate}:${endDate}`;

    //cache check
    const cachedData = await client.get(key);
    if(cachedData){
      console.log("Cache hit for key:", key);
      const correlationId = crypto.randomUUID();

      for (const queue of senderQueue) {
        channel.sendToQueue(queue,
          Buffer.from(JSON.stringify({ type: queue.split("_")[0], key })),
          { persistent: true, correlationId, replyTo: responseQueue }
        );
      }

    const results = await new Promise((resolve) => {
      pending.set(correlationId, { collected: [], resolve });
    });

    return res.json({ results });




    }


    
    const data = await yf.historical(ticker, { period1: startDate, period2: endDate });

      if (!data || data.length === 0) {
        return res.status(404).json({ error: `No data found for ticker: ${ticker}` });
      }

    const d = data.map((entry) => ({
      date: entry.date,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
      volume: entry.volume
    }));

    //cache the data for 1 hour
    await client.setEx(key, 3600, JSON.stringify(d));

    const correlationId = crypto.randomUUID();

for (const queue of senderQueue) {
  channel.sendToQueue(queue,
    Buffer.from(JSON.stringify({ type: queue.split("_")[0], key })),
    { persistent: true, correlationId, replyTo: responseQueue }
  );

  console.log("Sent message to queue:", queue, "with key:", key);

}

    const results = await new Promise((resolve) => {
  pending.set(correlationId, { collected: [], resolve });
});

return res.json({ results });
  } catch (error) {
    console.error(error);
    console.error("Error fetching data for ticker:", ticker, "with dates:", startDate, endDate);
    res.status(500).json({ error: "Failed to fetch data" });
  }
})


app.get("/send-message-via-queue/:message", async (req, res) => {
  const message = req.params.message;
  const senderQueue = "ema_queue";
  try {
    await channel.sendToQueue(senderQueue, Buffer.from(message), { persistent: true });
    console.log("Sent message to queue:", message);
    res.json({ status: "Message sent to queue", message });
  } catch (error) {
    console.error("Failed to send message to queue:", error);
    res.status(500).json({ error: "Failed to send message to queue" });
  }   
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(cors());
// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, async() => {
  console.log(`Server running on http://localhost:${PORT}`);
});