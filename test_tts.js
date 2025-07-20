require("dotenv").config();
const axios = require("axios");
const fs = require("fs");

(async () => {
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.VOICE_ID}/stream`,
      {
        text: "This is a test",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.7
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        responseType: "arraybuffer"
      }
    );

    fs.writeFileSync("test.mp3", res.data);
    console.log("✅ Success! File saved as test.mp3");
  } catch (err) {
    console.error("❌ Error:", err.response?.status, err.response?.data || err.message);
  }
})();
