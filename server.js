import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not configured.");
}

const app = express();

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    service: "Telugu-English Phone Assistant",
    voice: "Leda",
    provider: "Exotel + Gemini Live",
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/media",
});

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

const SYSTEM_INSTRUCTION = `
You are a personal phone assistant.

You speak ONLY Telugu and English.

You understand:
- Telugu
- English
- Natural Telugu-English mixed speech.

Your voice personality:
- Young adult female.
- Natural, warm and friendly.
- Dynamic and expressive.
- Confident but not overly formal.
- Natural Indian English pronunciation.
- Natural Telugu pronunciation.
- Never sound like a robotic IVR.

You are answering phone calls on behalf of the owner
when he is unavailable.

Never pretend to be the owner.

Keep phone responses short and conversational.

If the caller asks for the owner:
say that the owner is currently unavailable.

If the caller wants to leave a message:
listen carefully and acknowledge it.

Do not invent information.

Do not make up personal details about the owner.

Use natural Telugu-English code switching when appropriate.

Example style:
"Aayana ippudu available ga leru. Meeku emaina message cheppala?"

When the conversation is finished:
say goodbye naturally.

Example:
"Okay, thank you. Bye!"

Do not continue talking after the caller clearly says goodbye.
`;

wss.on("connection", async (exotelWs) => {
  console.log("Exotel WebSocket connected.");

  let streamSid = null;
  let geminiSession = null;
  let closed = false;

  try {
    geminiSession = await ai.live.connect({
      model: "gemini-3.8-live",

      config: {
        responseModalities: [Modality.AUDIO],

        systemInstruction: SYSTEM_INSTRUCTION,

        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Leda",
            },
          },
        },

        // Let Gemini detect natural pauses in phone speech.
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
          },
        },
      },

      callbacks: {
        onopen() {
          console.log("Gemini Live connected.");
        },

        onmessage(message) {
          if (closed || exotelWs.readyState !== 1) {
            return;
          }

          const parts =
            message?.serverContent?.modelTurn?.parts || [];

          for (const part of parts) {
            const inlineData = part?.inlineData;

            if (!inlineData?.data) {
              continue;
            }

            const mimeType = inlineData.mimeType || "";

            // Gemini Live normally returns 24 kHz PCM.
            if (!mimeType.includes("audio/pcm")) {
              continue;
            }

            const geminiAudio = Buffer.from(
              inlineData.data,
              "base64"
            );

            // Gemini: 24 kHz PCM
            // Exotel: 8 kHz PCM
            const exotelAudio = resamplePCM16(
              geminiAudio,
              24000,
              8000
            );

            exotelWs.send(
              JSON.stringify({
                event: "media",
                stream_sid: streamSid,
                media: {
                  payload: exotelAudio.toString("base64"),
                },
              })
            );
          }
        },

        onerror(error) {
          console.error("Gemini Live error:", error);
        },

        onclose(event) {
          console.log(
            "Gemini Live closed:",
            event?.reason || "unknown"
          );
        },
      },
    });

    console.log("Gemini session ready.");

    // Initial greeting.
    geminiSession.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              text:
                "The phone call has just connected. Greet the caller naturally and briefly.",
            },
          ],
        },
      ],
      turnComplete: true,
    });

    exotelWs.on("message", async (raw) => {
      if (closed) return;

      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        console.error("Invalid Exotel JSON.");
        return;
      }

      switch (message.event) {
        case "connected":
          console.log("Exotel event: connected");
          break;

        case "start":
          streamSid =
            message.stream_sid ||
            message.start?.stream_sid ||
            null;

          console.log("Exotel stream started:", streamSid);

          console.log(
            "Audio format:",
            message.start?.media_format
          );
          break;

        case "media": {
          const payload = message.media?.payload;

          if (!payload || !geminiSession) {
            return;
          }

          const exotelAudio = Buffer.from(
            payload,
            "base64"
          );

          // Exotel default: 8 kHz PCM
          // Gemini input: 16 kHz PCM
          const geminiAudio = resamplePCM16(
            exotelAudio,
            8000,
            16000
          );

          geminiSession.sendRealtimeInput({
            audio: {
              data: geminiAudio.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          });

          break;
        }

        case "dtmf":
          console.log(
            "DTMF:",
            message.dtmf?.digit
          );
          break;

        case "stop":
          console.log(
            "Exotel stream stopped:",
            message.stop?.reason
          );

          closeSession();
          break;

        case "clear":
          console.log("Exotel requested audio clear.");
          break;

        case "mark":
          break;

        default:
          console.log(
            "Unknown Exotel event:",
            message.event
          );
      }
    });

    exotelWs.on("close", () => {
      console.log("Exotel WebSocket closed.");
      closeSession();
    });

    exotelWs.on("error", (error) => {
      console.error("Exotel WebSocket error:", error);
      closeSession();
    });

    function closeSession() {
      if (closed) return;

      closed = true;

      try {
        geminiSession?.close();
      } catch {}

      geminiSession = null;
    }
  } catch (error) {
    console.error(
      "Failed to create Gemini session:",
      error
    );

    try {
      exotelWs.close();
    } catch {}
  }
});

function resamplePCM16(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return buffer;
  }

  const inputSamples = Math.floor(buffer.length / 2);

  if (inputSamples <= 1) {
    return buffer;
  }

  const outputSamples = Math.floor(
    inputSamples * outputRate / inputRate
  );

  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const sourcePosition =
      i * (inputSamples - 1) /
      Math.max(1, outputSamples - 1);

    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(
      leftIndex + 1,
      inputSamples - 1
    );

    const fraction =
      sourcePosition - leftIndex;

    const left =
      buffer.readInt16LE(leftIndex * 2);

    const right =
      buffer.readInt16LE(rightIndex * 2);

    const sample =
      left + (right - left) * fraction;

    output.writeInt16LE(
      Math.max(
        -32768,
        Math.min(32767, Math.round(sample))
      ),
      i * 2
    );
  }

  return output;
}

server.listen(PORT, () => {
  console.log(
    `Telugu-English Phone Assistant listening on port ${PORT}`
  );
});
