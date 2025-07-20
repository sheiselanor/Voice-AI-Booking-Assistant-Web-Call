let ws;
let mediaRecorder;
let conversationActive = true;
let currentAudio = null;
let holdMusic = null;

const recordBtn = document.getElementById("recordBtn");
const hangupBtn = document.getElementById("hangupBtn");
const statusEl = document.getElementById("status");

// ✅ Create and manage WebSocket connection
function createWebSocket() {
  ws = new WebSocket("ws://localhost:3000");

  ws.onopen = () => {
    console.log("✅ WebSocket connected");
    statusEl.innerText = "🟢 Connected to server";
  };

  ws.onclose = () => {
    console.log("🔴 WebSocket closed");
    statusEl.innerText = "🔴 Disconnected";
  };

  ws.onerror = (err) => {
    console.error("❌ WebSocket error:", err);
    statusEl.innerText = "❌ WebSocket error";
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // Handle stopMusic signal
    if (data.stopMusic) {
      console.log("🛑 Stopping hold music");
      if (holdMusic) {
        holdMusic.pause();
        holdMusic.currentTime = 0;
      }
      return;
    }

    // Handle audio playback
    const audio = new Audio(data.audio + `?t=${Date.now()}`);

    // Special handling for hold music
    if (data.audio.includes("holdon")) {
      holdMusic = audio;
      audio.loop = true; // Optional: loop until stopped
      audio.play();
      statusEl.innerText = "🎵 Please hold, AI is preparing your response...";
      return;
    }

    if (currentAudio) currentAudio.pause();

    currentAudio = audio;
    audio.play();
    statusEl.innerText = data.audio.includes("filler")
      ? "🤖 AI is thinking..."
      : "🤖 Reply is playing...";

    audio.onended = () => {
      if (data.audio.includes("filler")) return;
      if (conversationActive) {
        startRecording();
      } else {
        statusEl.innerText = "✅ Session ended.";
      }
    };
  };
}

createWebSocket(); // 🔁 Establish connection initially

// ✅ Start recording voice and send to Deepgram
const startRecording = async () => {
  if (!conversationActive) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("⚠️ WebSocket not open. Trying to reconnect...");
    createWebSocket();
    await new Promise((res) => setTimeout(res, 1000));
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioChunks = [];
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (event) => {
    audioChunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    console.log("🛑 Recording stopped, sending audio to Deepgram...");
    const blob = new Blob(audioChunks, { type: "audio/webm" });

    try {
      const dg = await fetch("https://api.deepgram.com/v1/listen", {
        method: "POST",
        headers: {
          Authorization: "Token 2843890e6def3da81b83345c0740a75ef9508f02", // 🔐 Replace if needed
          "Content-Type": "audio/webm",
        },
        body: blob,
      });

      const data = await dg.json();
      const transcript = data.results.channels[0].alternatives[0].transcript;
      console.log("📝 Transcript from Deepgram:", transcript);

      if (transcript && ws.readyState === WebSocket.OPEN) {
        ws.send(transcript);
        statusEl.innerText = `🗣️ You said: ${transcript}`;
      }

      const goodbyeWords = [
        "goodbye", "bye", "that's all", "no that’s all", "nothing else", "no more", "thank you"
      ];
      if (
        goodbyeWords.some((phrase) => transcript.toLowerCase().includes(phrase))
      ) {
        conversationActive = false;
        statusEl.innerText = "👋 Conversation ended naturally.";
      }

    } catch (err) {
      console.error("❌ Deepgram error:", err);
      statusEl.innerText = "❌ Speech recognition failed.";
    }

    stream.getTracks().forEach((track) => track.stop());
  };

  console.log("🎙️ Start recording...");
  statusEl.innerText = "🎙️ Listening...";
  mediaRecorder.start();

  setTimeout(() => {
    console.log("⏹️ Stop recording after 15s");
    if (mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, 15000);
};

// ▶️ Button: Start conversation
recordBtn.onclick = () => {
  conversationActive = true;
  startRecording();
};

// 🟥 Button: Hang up manually
hangupBtn.onclick = () => {
  conversationActive = false;

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }

  if (holdMusic) {
    holdMusic.pause();
    holdMusic.currentTime = 0;
  }

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  statusEl.innerText = "📴 Conversation manually ended.";
};
