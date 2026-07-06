import { AgentClient, EventType } from '@croo-network/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import TurndownService from 'turndown';
import * as dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const sdkKey = process.env.CROO_SDK_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!sdkKey || !GEMINI_API_KEY || !GROQ_API_KEY) {
  console.error("FATAL: Missing API keys in environment variables.");
  process.exit(1);
}

const client = new AgentClient({ baseURL: process.env.CROO_API_URL, wsURL: process.env.CROO_WS_URL }, sdkKey);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const groq = new Groq({ apiKey: GROQ_API_KEY });

const turndownService = new TurndownService();
turndownService.addRule('remove-scripts-styles', {
  filter: ['script', 'style', 'noscript', 'nav', 'footer'],
  replacement: () => ''
});

async function startAgent() {
  try {
    const stream = await client.connectWebSocket();
    console.log("=========================================");
    console.log(" ToS Trap Scanner LIVE (RENDER CLOUD)");
    console.log(" Engines: Primary [Gemini] | Fallback [Groq]");
    console.log("=========================================");

    stream.onAny((e) => {
        if(e && e.type) console.log(`\n[NETWORK PING] Event received: ${e.type}`);
    });

    stream.on(EventType.NegotiationCreated, async (event) => {
      const negId = event.negotiation_id || event.id; 
      if (!negId) return;
      console.log(`Processing negotiation ID: ${negId}`);
      try {
        await client.acceptNegotiation(negId);
        console.log(`[SUCCESS] Negotiation accepted. Awaiting buyer payment...`);
      } catch (err) {
        console.error(`[NON-FATAL ERROR] SDK refused negotiation:`, err.message);
      }
    });

    stream.on(EventType.OrderPaid, async (event) => {
      const orderId = event.order_id || event.id;
      if (!orderId) return;

      console.log(`Order ${orderId} PAID. Fetching full order data from chain...`);

      try {
          const order = await client.getOrder(orderId);
          const reqString = typeof order.requirements === 'string' ? order.requirements : JSON.stringify(order.requirements || {});
          const urlMatch = reqString.match(/https?:\/\/[^\s"'}\\>\]]+/i);
          
          if (!urlMatch) {
             console.error("[WARN] Extraction failed. Could not find a URL.");
             await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({ error: "No URL found in requirements." }) });
             return;
          }

          const targetUrl = urlMatch[0];
          console.log(`Target URL locked: ${targetUrl}`);
          
          const fetchOptions = {
              headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                  "Connection": "keep-alive"
              }
          };

          const pageRes = await fetch(targetUrl, fetchOptions);
          if (!pageRes.ok) throw new Error(`HTTP Status ${pageRes.status}`);
          
          const html = await pageRes.text();
          let cleanText = turndownService.turndown(html).substring(0, 80000); 
          
          const prompt = `You are a ruthless legal compliance auditor. Scan this Markdown-formatted Terms of Service document and output a strict JSON object evaluating it. Do not include markdown code blocks like \`\`\`json around your response, just output the raw JSON.
          Look for: 1) IP forfeiture 2) Forced arbitration clauses 3) Predatory data selling
          
          Output exact schema:
          {
            "target_url": "${targetUrl}",
            "ip_risk": "High/Low - Reason",
            "arbitration_clause": "Yes/No",
            "data_selling": "Yes/No - Reason",
            "overall_risk_score": "1-10",
            "verdict": "Short punchy summary"
          }
          
          Document to scan:
          ${cleanText}`;

          let aiText = "";

          // DUAL-ENGINE ARCHITECTURE
          try {
              console.log("Analyzing text via Primary Engine [Gemini]...");
              const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
              const result = await model.generateContent(prompt);
              aiText = result.response.text().trim();
          } catch (geminiErr) {
              console.log(`[WARNING] Gemini failed: ${geminiErr.message}`);
              console.log("Engaging Fallback Engine [Groq Llama-3]...");
              
              const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.1,
              });
              aiText = chatCompletion.choices[0]?.message?.content.trim() || "";
          }

          if (aiText.startsWith('```')) aiText = aiText.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();

          console.log("Synthesis complete. Transmitting payload...");
          await client.deliverOrder(orderId, { deliverable_text: aiText }); 
          console.log(`[SUCCESS] Order ${orderId} fully processed and delivered.\n`);

      } catch (execErr) {
        console.error(`[EXECUTION ERROR] Loop failed:`, execErr.message);
        try {
          await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({ error: `Audit failed: ${execErr.message}` }) });
        } catch (fallbackErr) {}
      }
    });

    stream.on('error', (err) => console.error("WebSocket Error:", err.message));
    stream.on('close', () => console.log("WebSocket connection closed. SDK will attempt reconnect."));

  } catch (err) {
    console.error("Failed to boot agent:", err.message);
    process.exit(1);
  }
}

startAgent();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ToS Scanner Agent is Alive\n');
}).listen(PORT, () => {
    console.log(`Health check active on port ${PORT}`);
});
