import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

// Set up larger JSON limit for base64 image transfers
app.use(express.json({ limit: "15mb" }));

// Initialize Google GenAI
const apiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
} else {
  console.warn("WARNING: GEMINI_API_KEY environment variable is not set.");
}

// Helper function to call Gemini API with robust retries, jittered exponential backoff, and model fallback
async function generateTagContentWithRetry(imagePart: any, promptText: string) {
  // Use 'gemini-3.5-flash' as the primary model due to superior speed, OCR reliability, and low latency.
  // 'gemini-3.1-flash-lite' serves as a lightweight secondary fallback if needed, but 3.5-flash resolves correctly on the first try much faster.
  const models = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
  let lastError: any = null;

  for (const model of models) {
    let delay = 800; // start with shorter delay for high-speed workflows
    const maxRetries = model === "gemini-3.5-flash" ? 2 : 1; // 2 attempts for primary, 1 for secondary to fail fast

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[AI Extraction] Scanning tag utilizing model: ${model} (attempt ${attempt}/${maxRetries}, ultra-latency mode)...`);
        const response = await ai!.models.generateContent({
          model: model,
          contents: { parts: [imagePart, { text: promptText }] },
          config: {
            temperature: 0.0, // Force high determinism to skip exploration routes and accelerate extraction
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                partNumber: { 
                  type: Type.STRING, 
                  description: "The core part number or style code (e.g., '123456-78' or 'M123A')." 
                },
                size: { 
                  type: Type.STRING, 
                  description: "The primary clothing size (e.g., 'M', '150', '38' or 'L')." 
                },
                color: { 
                  type: Type.STRING, 
                  description: "The color name or code (e.g., '09 BLACK', 'Navy', or 'IVORY')." 
                },
              },
              required: ["partNumber", "size", "color"]
            },
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL // Bypass model reasoning tree for immediate OCR/structural output
            },
            systemInstruction: "You are a sub-second apparel OCR structural data parser. Read the clothing tag picture and instantly parse to JSON. Respond instantly with zero unnecessary delays. Do not explain, just return JSON.",
          }
        });

        if (response && response.text) {
          console.log(`[AI Extraction] Successfully parsed clothing tag with ${model}`);
          return response;
        }
        throw new Error("Received empty text or unreadable content stream from model");
      } catch (err: any) {
        lastError = err;
        const errMsgHex = typeof err === "object" ? (err.message || JSON.stringify(err)) : String(err);
        console.warn(`[AI Extraction] Model ${model} on attempt ${attempt} threw: ${errMsgHex}`);

        // Handle transient 503, 500, 429 rate limit errors or structural overloads
        const isTransient = 
          errMsgHex.includes("503") || 
          errMsgHex.includes("500") || 
          errMsgHex.includes("UNAVAILABLE") || 
          errMsgHex.includes("429") || 
          errMsgHex.includes("demand") ||
          errMsgHex.includes("overloaded") ||
          errMsgHex.includes("ResourceExhausted") ||
          err.status === 503 ||
          err.status === 429;

        if (isTransient && attempt < maxRetries) {
          const jitter = Math.random() * 150;
          const waitTime = delay + jitter;
          console.log(`[AI Extraction] Target service busy ("${errMsgHex.substring(0, 80)}..."). Retrying in ${Math.round(waitTime)}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          delay *= 1.3; // slightly faster exponential retry pacing for active operators
        } else {
          // Break internal retry loop, allowing outer loop to try alternative model
          break;
        }
      }
    }
    console.log(`[AI Extraction] Attempt utilizing ${model} was unsuccessful or timed out. Transitioning to fallback engine...`);
  }

  throw lastError || new Error("Failed to extract clothing tag parameters after exhaustively querying AI engine pipeline.");
}

// REST API endpoint to extract info from clothing tag images
app.post("/api/extract", async (req, res) => {
  try {
    if (!ai) {
      return res.status(500).json({ error: "Gemini API key is not configured on the server." });
    }

    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    // Prepare content for Gemini
    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    
    const imagePart = {
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: cleanBase64,
      },
    };

    const promptText = `Analyze the clothing tag image and strictly extract the following details of interest:
1. "Part Number" (often labeled as "NO", "品番", "STYLE", "品名", or "Model/Ref"). Extract only the alphanumeric identifier string. Clean it by removing generic prefixes or trailing garbage.
2. "Size" (often labeled as "SIZE", "サイズ", "Height/身長", or listed as S, M, L, XL, 120, 150, 38). Focus on the core main size identifier.
3. "Color" (often labeled as "COL", "カラー", "色", "COLOR"). Extract the color code, color name, or both (e.g. "09 BLACK", "NAVY").

Ensure correct language translation understanding (especially for Japanese tags which are very common, e.g. 品番 = Part Number, サイズ = Size, カラー/色/COL = Color). Return JSON format. Output empty string if anything is completely missing.`;

    const response = await generateTagContentWithRetry(imagePart, promptText);

    if (!response || !response.text) {
      throw new Error("No response or empty text from Gemini model");
    }

    const data = JSON.parse(response.text.trim());
    return res.json(data);
  } catch (error: any) {
    console.error("Extraction error:", error);
    
    // Check if high load or 503 is returned to give user a friendly actionable response.
    const rawMessage = error.message || "";
    if (rawMessage.includes("503") || rawMessage.includes("demand") || rawMessage.includes("UNAVAILABLE")) {
      return res.status(503).json({
        error: "Google's Gemini core model is experiencing temporary peak load spikes. Please capture another tag frame or click Retry in a moment."
      });
    }

    return res.status(500).json({ error: error.message || "Failed to extract tag information" });
  }
});

// Vite middleware flow for full stack development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
