require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Airtable = require("airtable");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const sessions = {};

app.use(express.static("public"));

wss.on("connection", (ws) => {
  console.log("✅ Client connected via WebSocket");
  const socketId = ws._socket.remoteAddress + ":" + ws._socket.remotePort;

  if (!sessions[socketId]) {
    sessions[socketId] = {
      recordId: null,
      bookingData: {
        Name: "",
        Date: "",
        Time: "",
        Location: "",
        Preferences: ""
      }
    };
  }

  ws.on("message", async (message) => {
    const userMessage = message.toString().trim();
    console.log("🎙️ Received:", userMessage);
    const session = sessions[socketId];

    // Step 0: Send filler immediately
    const fillerOptions = [
      "Alright, please, give me a second. I'll get back to you shortly...",
      "Let me check that for you. Please stay with me...",
      "Got it. please, give me a second. I'll get back to you shortly..."
    ];
    const filler = fillerOptions[Math.floor(Math.random() * fillerOptions.length)];

    try {
      const fillerRes = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream`,
        { text: filler, voice_settings: { stability: 0.4, similarity_boost: 0.7 } },
        {
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": process.env.ELEVENLABS_API_KEY
          },
          responseType: "arraybuffer"
        }
      );

      const fillerPath = path.join(__dirname, "public", "filler.mp3");
      fs.writeFileSync(fillerPath, fillerRes.data);
      ws.send(JSON.stringify({ audio: "/filler.mp3" }));
    } catch (err) {
      console.error("❌ Filler TTS error:", err.message);
    }

    // Step 0.5: Trigger hold music after 2 seconds
    setTimeout(() => {
      ws.send(JSON.stringify({ audio: "/holdon.mp3" }));
    }, 2000);

    // Step 1: Ask DeepSeek to extract fields
    const extractPrompt = `
You're a helpful booking assistant for a dialysis center.

From the user's message, extract the following fields as JSON object:
- Name
- Date (format YYYY-MM-DD)
- Time (e.g., 3:00 PM)
- Location
- Preferences

If any info is not mentioned, leave it as an empty string. Output ONLY a valid JSON object, no extra words.

User: """${userMessage}"""
`;

    let extracted = {};
    let rawJSON = "";

    try {
      const extractRes = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: [{ role: "system", content: extractPrompt }]
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
          }
        }
      );

      rawJSON = extractRes.data.choices[0].message.content;
      console.log("📦 Raw JSON from DeepSeek:\n", rawJSON);
      rawJSON = rawJSON.replace(/```json|```/gi, "").trim();
      extracted = JSON.parse(rawJSON);
      console.log("🧠 Extracted by DeepSeek:", extracted);
    } catch (err) {
      console.error("❌ Failed to parse DeepSeek JSON:", err.message);
    }

    const updatedFields = {};
    for (const field of ["Name", "Date", "Time", "Location", "Preferences"]) {
      if (extracted[field] && extracted[field].trim()) {
        session.bookingData[field] = extracted[field].trim();
        updatedFields[field] = session.bookingData[field];
        console.log(`✅ ${field}:`, updatedFields[field]);
      }
    }

    // Airtable
    try {
      if (!session.recordId) {
        const record = await base("Conversations").create([
          {
            fields: {
              ...updatedFields,
              "User Transcript": userMessage,
              "AI Reply": "(waiting...)"
            }
          }
        ]);
        session.recordId = record[0].id;
        console.log("📌 New Airtable record created:", session.recordId);
      } else {
        await base("Conversations").update([
          {
            id: session.recordId,
            fields: {
              ...updatedFields,
              "User Transcript": userMessage
            }
          }
        ]);
        console.log("🔁 Airtable record updated:", session.recordId);
      }
    } catch (err) {
      console.error("❌ Airtable error:", err.message);
    }

    // Step 2: Build DeepSeek reply prompt
    const missing = Object.entries(session.bookingData)
      .filter(([_, v]) => !v)
      .map(([k]) => k.toLowerCase());

    let systemPrompt = `You are a friendly multilingual AI for booking dialysis appointments. Reply clearly like a booking assistant and keep it short and precise like a human.`;

    if (missing.length > 0) {
      systemPrompt += ` Ask for missing: ${missing.join(", ")}.`;
    } else {
      systemPrompt += ` All details provided. Confirm and thank the user.`;
    }

    // Step 3: DeepSeek reply
    let reply = "";
    try {
      const replyRes = await axios.post(
        "https://api.deepseek.com/chat/completions",
        {
          model: "deepseek-chat",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ]
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
          }
        }
      );
      reply = replyRes.data.choices[0].message.content;
      console.log("🤖 DeepSeek Reply:", reply);
    } catch (err) {
      console.error("❌ DeepSeek reply error:", err.message);
    }

    // Step 4: Update Airtable reply
    try {
      await base("Conversations").update([
        {
          id: session.recordId,
          fields: { "AI Reply": reply }
        }
      ]);
    } catch (err) {
      console.error("❌ Airtable update error:", err.message);
    }

    // Step 5: Send stopMusic signal + "Thanks for waiting" + final reply
    try {
      // Tell frontend to stop hold music
      ws.send(JSON.stringify({ stopMusic: true }));

      // "Thanks for waiting"
      const thanksRes = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream`,
        { text: "Thanks for waiting!", voice_settings: { stability: 0.4, similarity_boost: 0.7 } },
        {
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": process.env.ELEVENLABS_API_KEY
          },
          responseType: "arraybuffer"
        }
      );
      const thanksPath = path.join(__dirname, "public", "thanks.mp3");
      fs.writeFileSync(thanksPath, thanksRes.data);
      ws.send(JSON.stringify({ audio: "/thanks.mp3" }));

      // Final reply
      const ttsRes = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream`,
        { text: reply, voice_settings: { stability: 0.4, similarity_boost: 0.7 } },
        {
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": process.env.ELEVENLABS_API_KEY
          },
          responseType: "arraybuffer"
        }
      );

      const replyPath = path.join(__dirname, "public", "reply.mp3");
      fs.writeFileSync(replyPath, ttsRes.data);
      ws.send(JSON.stringify({ audio: "/reply.mp3" }));
    } catch (err) {
      console.error("❌ Final TTS error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed");
    delete sessions[socketId];
  });
});

server.listen(process.env.PORT, () =>
  console.log(`🚀 Voice AI server running at http://localhost:${process.env.PORT}`)
);
