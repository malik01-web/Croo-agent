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

          // FIX: tightened URL match to avoid grabbing an unrelated URL
          // elsewhere in the requirements blob. Prefers a URL attached to a
          // known field name (url/target_url/link/website), falls back to
          // the old broad match only if no labeled field is found.
          let targetUrl = null;
          const labeledMatch = reqString.match(/"(?:url|target_url|link|website)"\s*:\s*"(https?:\/\/[^"]+)"/i);
          if (labeledMatch) {
            targetUrl = labeledMatch[1];
          } else {
            const urlMatch = reqString.match(/https?:\/\/[^\s"'}\\>\]]+/i);
            if (urlMatch) targetUrl = urlMatch[0];
          }

          if (!targetUrl) {
             console.error("[WARN] Extraction failed. Could not find a URL.");
             await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({ error: "No URL found in requirements." }) });
             return;
          }

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

          // FIX: reject non-HTML responses (PDFs, binaries) before Turndown
          // ever touches them. Prevents scanning garbage bytes as if it were text.
          const contentType = pageRes.headers.get('content-type') || '';
          if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
            console.error(`[WARN] Non-HTML content-type received: ${contentType}`);
            await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({
              target_url: targetUrl,
              error: `Target returned non-HTML content (${contentType}). Cannot scan PDFs or binary files in this version.`
            }) });
            return;
          }

          const html = await pageRes.text();
          // FIX: Gemini keeps the original generous cap — it has a much
          // higher token ceiling and handled long documents fine.
          const GEMINI_MAX_CHARS = 80000;
          let cleanText = turndownService.turndown(html).substring(0, GEMINI_MAX_CHARS);

          // FIX: sanity-check extracted content before spending an LLM call
          // on it. Catches cookie walls, JS-required pages, bot-block pages,
          // and empty/near-empty scrapes.
          const MIN_CONTENT_LENGTH = 500;
          const looksLikeToS = /terms|agreement|arbitration|liability|policy|user|service/i.test(cleanText);
          if (cleanText.length < MIN_CONTENT_LENGTH || !looksLikeToS) {
            console.error(`[WARN] Extracted content failed sanity check. Length: ${cleanText.length}`);
            await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({
              target_url: targetUrl,
              error: "Could not extract readable ToS content from this URL. The page may require JavaScript, sit behind a cookie/login wall, or not contain a Terms of Service document."
            }) });
            return;
          }

          // FIX: Groq's on_demand tier caps at 12000 TPM. Long documents
          // (e.g. Binance's ToS at ~16k tokens) blow past that when Gemini
          // fails over and this fallback fires. Roughly 4 chars/token, so
          // cap Groq's input well under the limit to leave headroom for the
          // prompt scaffolding + expected output tokens.
          const GROQ_MAX_CHARS = 30000;

          const buildPrompt = (text) => `You are a ruthless legal compliance auditor. Scan this Markdown-formatted Terms of Service document and output a strict JSON object evaluating it. Do not include markdown code blocks like \`\`\`json around your response, just output the raw JSON.
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
          ${text}`;

          let aiText = "";

          // DUAL-ENGINE ARCHITECTURE
          try {
              console.log("Analyzing text via Primary Engine [Gemini]...");
              const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
              const result = await model.generateContent(buildPrompt(cleanText));
              aiText = result.response.text().trim();
          } catch (geminiErr) {
              console.log(`[WARNING] Gemini failed: ${geminiErr.message}`);
              console.log("Engaging Fallback Engine [Groq Llama-3]...");

              const groqText = cleanText.length > GROQ_MAX_CHARS
                ? cleanText.substring(0, GROQ_MAX_CHARS)
                : cleanText;
              if (cleanText.length > GROQ_MAX_CHARS) {
                console.log(`[INFO] Truncated document from ${cleanText.length} to ${GROQ_MAX_CHARS} chars for Groq TPM limit.`);
              }

              const chatCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: buildPrompt(groqText) }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.1,
              });
              aiText = chatCompletion.choices[0]?.message?.content.trim() || "";
          }

          if (aiText.startsWith('```')) aiText = aiText.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();

          // FIX: validate the model actually returned parseable JSON before
          // delivering it as a structured result. On failure, retry once
          // with the fallback engine (Groq) instead of shipping broken output.
          let parsedOk = false;
          try {
            JSON.parse(aiText);
            parsedOk = true;
          } catch (parseErr) {
            console.error(`[WARN] Primary output failed JSON.parse: ${parseErr.message}`);
          }

          if (!parsedOk) {
            try {
              console.log("Retrying synthesis via Groq (JSON validation failure on first attempt)...");
              const retryCompletion = await groq.chat.completions.create({
                messages: [{ role: "user", content: prompt }],
                model: "llama-3.3-70b-versatile",
                temperature: 0.1,
              });
              let retryText = retryCompletion.choices[0]?.message?.content.trim() || "";
              if (retryText.startsWith('```')) retryText = retryText.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();

              JSON.parse(retryText); // will throw if still invalid
              aiText = retryText;
              parsedOk = true;
            } catch (retryErr) {
              console.error(`[WARN] Retry also failed JSON.parse: ${retryErr.message}`);
            }
          }

          if (!parsedOk) {
            console.error(`[FAIL] Could not produce valid JSON after retry. Delivering error instead of malformed output.`);
            await client.deliverOrder(orderId, { deliverable_text: JSON.stringify({
              target_url: targetUrl,
              error: "Analysis engine failed to produce valid structured output for this document. Please retry."
            }) });
            return;
          }

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
