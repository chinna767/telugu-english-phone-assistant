import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
  res.json({
    ok: true,
    geminiConfigured: Boolean(GEMINI_API_KEY),
  });
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/media",
});

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const SYSTEM_INSTRUCTION = `
You are a personal phone assistant.

LANGUAGES:
Speak ONLY Telugu and English.
Understand Telugu, English, and natural Telugu-English mixed speech.

VOICE PERSONALITY:
You are a young adult female voice.
You sound natural, warm, friendly, lively and expressive.
You have a dynamic conversational personality.
You sound like a real human phone assistant, NOT a robotic IVR.
Use natural Indian English pronunciation.
Use natural Telugu pronunciation.
Do not exaggerate emotions.

PHONE CONVERSATION STYLE:
Keep responses short and natural.
Do not give long speeches.
Allow the caller to speak.
Do not interrupt unnecessarily.

ROLE:
You answer calls on behalf of the owner when he is unavailable.
Never pretend to be the owner.
Never claim to be physically present with the owner.

OWNER:
If the caller asks for the owner, say that the owner is currently unavailable.

MESSAGES:
If the caller wants to leave a message, listen carefully,
acknowledge the message, and do not invent or modify details.

TRUTHFULNESS:
Never invent personal information.
Never guess information about the owner.
If you do not know something, say so naturally.

LANGUAGE MIXING:
If the caller speaks Telugu-English naturally,
you may respond naturally in Telugu-English.
If the caller speaks mostly Telugu, respond mostly Telugu.
If the caller speaks mostly English, respond mostly English.

GOODBYE:
When the caller clearly finishes the conversation,
say a short natural goodbye and stop responding.

Example:
"Okay, thank you. Bye!"

Do not continue the conversation after a clear goodbye.
`;

wss.on("connection", async (exotelWs) => {
  console.log("Exotel Voicebot WebSocket connected.");

  if (!ai) {
    console.error("GEMINI_API_KEY is missing.");
    exotelWs.close();
    return;
  }

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
          if (
            closed ||
            !message ||
            exotelWs.readyState !== 1
          ) {
            return;
          }

          const parts =
            message?.serverContent?.modelTurn?.parts || [];

          for (const part of parts) {
            const inlineData = part?.inlineData;

            if (!inlineData?.data) {
              continue;
            }

            const mimeType =
              inlineData.mimeType || "";

            if (!mimeType.startsWith("audio/pcm")) {
              continue;
            }

            // Gemini Live audio output is 24 kHz,
            // 16-bit, mono, little-endian PCM.
            const geminiAudio = Buffer.from(
              inlineData.data,
              "base64"
            );

            // Exotel Voicebot expects:
            // 8 kHz, 16-bit, mono PCM.
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
                  payload:
                    exotelAudio.toString("base64"),
                },
              })
            );
          }
        },

        onerror(error) {
          console.error(
            "Gemini Live error:",
            error
          );
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

    // Ask Gemini to generate the initial greeting.
    geminiSession.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              text:
                "The phone call has just connected. Give a short, natural greeting to the caller.",
            },
          ],
        },
      ],
      turnComplete: true,
    });

    exotelWs.on("message", (raw) => {
      if (closed || !geminiSession) {
        return;
      }

      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        console.error(
          "Received invalid Exotel JSON."
        );
        return;
      }

      switch (message.event) {
        case "connected":
          console.log(
            "Exotel event: connected"
          );
          break;

        case "start": {
          streamSid =
            message.stream_sid ||
            message.start?.stream_sid ||
            null;

          console.log(
            "Exotel stream started:",
            streamSid
          );

          console.log(
            "Exotel media format:",
            JSON.stringify(
              message.start?.media_format || {}
            )
          );

          break;
        }

        case "media": {
          const payload =
            message.media?.payload;

          if (!payload) {
            return;
          }

          const exotelAudio =
            Buffer.from(payload, "base64");

          // Exotel -> Gemini
          // 8 kHz PCM -> 16 kHz PCM.
          const geminiAudio =
            resamplePCM16(
              exotelAudio,
              8000,
              16000
            );

          geminiSession.sendRealtimeInput({
            audio: {
              data:
                geminiAudio.toString("base64"),
              mimeType:
                "audio/pcm;rate=16000",
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
            message.stop?.reason || "unknown"
          );

          closeSession();
          break;

        case "clear":
          console.log(
            "Exotel requested audio clear."
          );
          break;

        case "mark":
          break;

        default:
          console.log(
            "Exotel event:",
            message.event
          );
      }
    });

    exotelWs.on("close", () => {
      console.log(
        "Exotel WebSocket disconnected."
      );
      closeSession();
    });

    exotelWs.on("error", (error) => {
      console.error(
        "Exotel WebSocket error:",
        error
      );
      closeSession();
    });

    function closeSession() {
      if (closed) {
        return;
      }

      closed = true;

      try {
        geminiSession?.close();
      } catch {}

      geminiSession = null;
    }
  } catch (error) {
    console.error(
      "Failed to start Gemini session:",
      error
    );

    try {
      exotelWs.close();
    } catch {}
  }
});

/**
 * Simple linear PCM16 resampler.
 *
 * input:
 *   Buffer containing signed 16-bit little-endian PCM
 *
 * output:
 *   Buffer containing signed 16-bit little-endian PCM
 */
function resamplePCM16(
  buffer,
  inputRate,
  outputRate
) {
  if (inputRate === outputRate) {
    return buffer;
  }

  const inputSamples =
    Math.floor(buffer.length / 2);

  if (inputSamples <= 1) {
    return buffer;
  }

  const outputSamples =
    Math.max(
      1,
      Math.floor(
        inputSamples *
          outputRate /
          inputRate
      )
    );

  const output =
    Buffer.alloc(outputSamples * 2);

  for (
    let i = 0;
    i < outputSamples;
    i++
  ) {
    const sourcePosition =
      i *
      (inputSamples - 1) /
      Math.max(
        1,
        outputSamples - 1
      );

    const leftIndex =
      Math.floor(sourcePosition);

    const rightIndex =
      Math.min(
        leftIndex + 1,
        inputSamples - 1
      );

    const fraction =
      sourcePosition - leftIndex;

    const left =
      buffer.readInt16LE(
        leftIndex * 2
      );

    const right =
      buffer.readInt16LE(
        rightIndex * 2
      );

    const sample =
      left +
      (right - left) *
        fraction;

    output.writeInt16LE(
      Math.max(
        -32768,
        Math.min(
          32767,
          Math.round(sample)
        )
      ),
      i * 2
    );
  }

  return output;
}

server.listen(PORT, () => {
  console.log(
    `Telugu-English Phone Assistant running on port ${PORT}`
  );
});
