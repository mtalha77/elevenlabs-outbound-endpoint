import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";
import Fastify from "fastify";
import Twilio from "twilio";
import WebSocket from "ws";
import fastifyCors from "@fastify/cors";

dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  FORWARDING_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !FORWARDING_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Cache for ElevenLabs signed URLs to avoid delay when call is answered
const elevenLabsUrlCache = new Map();

// Define this variable at the top of the file, after the other constants
const IS_AWS_ENV =
  process.env.NODE_ENV === "production" || process.env.IS_AWS === "true";

// Pre-fetch ElevenLabs signed URL for faster connection when call is answered
async function prefetchSignedUrl() {
  try {
    const signedUrl = await getSignedUrl();
    const expiryTime = Date.now() + 1000 * 60 * 5; // URLs typically valid for ~10 min, keep for 5 min

    // Store in cache with timestamp - Map.set doesn't return a Promise so don't call .catch on it
    elevenLabsUrlCache.set("current", {
      url: signedUrl,
      expiryTime,
    });

    console.log("[ElevenLabs] Pre-fetched signed URL for future calls");
    return signedUrl;
  } catch (error) {
    console.error("[ElevenLabs] Failed to pre-fetch signed URL:", error);
    return null;
  }
}

// Get a signed URL (from cache if available, otherwise fetch new one)
async function getCachedSignedUrl() {
  const cached = elevenLabsUrlCache.get("current");

  if (cached && cached.expiryTime > Date.now()) {
    console.log("[ElevenLabs] Using cached signed URL");
    return cached.url;
  }

  console.log("[ElevenLabs] No valid cached URL, fetching new one...");
  return prefetchSignedUrl();
}

// Initialize URL cache
prefetchSignedUrl();
// Refresh cache periodically
setInterval(prefetchSignedUrl, 4 * 60 * 1000); // Refresh every 4 minutes

// UPDATED CORS CONFIGURATION - more comprehensive
await fastify.register(fastifyCors, {
  // Allow specific origins instead of wildcard "*"
  origin: (origin, cb) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return cb(null, true);
    }

    const allowedOrigins = [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      // Add your production domains here
      "https://www.rankorbit.ai",

      origin,
    ];

    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }

    return cb(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
  ],
  exposedHeaders: ["Content-Disposition"],
  credentials: true,
  maxAge: 3600,
  preflightContinue: false,
  optionsSuccessStatus: 204,
});

fastify.post("/proxy-outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
      statusCallback: `https://${request.headers.host}/call-status-callback`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: "initiated",
      startTime: new Date(),
      prompt,
      first_message,
    });

    broadcastCallUpdate({
      callSid: call.sid,
      number,
      status: "initiated",
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

const PORT = process.env.PORT || 3001;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const activeCalls = new Map();
const wsClients = new Set();

function shouldTransferToHuman(transcript) {
  const cleanTranscript = transcript
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");

  const transferPhrases = [
    "human",
    "representative",
    "agent",
    "person",
    "speak to someone",
    "talk to someone",
    "real person",
    "transfer",
    "speak with a human",
    "talk with a human",
  ];

  for (const phrase of transferPhrases) {
    if (cleanTranscript.includes(phrase)) {
      console.log(
        `[Twilio] Transfer phrase detected: "${phrase}" in "${cleanTranscript}"`
      );
      return true;
    }
  }

  if (
    cleanTranscript.includes("speak with") ||
    cleanTranscript.includes("talk with") ||
    cleanTranscript.includes("speak to") ||
    cleanTranscript.includes("talk to") ||
    cleanTranscript.includes("transfer me") ||
    cleanTranscript.includes("connect me")
  ) {
    console.log(
      `[Twilio] Transfer phrase detected in pattern: "${cleanTranscript}"`
    );
    return true;
  }

  return false;
}

async function forwardCallToHuman(callSid) {
  try {
    console.log(
      `[Twilio] ⚠️ FORWARDING CALL ${callSid} to human at ${FORWARDING_PHONE_NUMBER}`
    );

    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "forwarding";
      callInfo.forwardingTime = new Date();
      callInfo.forwardingInProgress = true;

      broadcastCallUpdate({
        callSid,
        status: "forwarding",
        forwardingTo: FORWARDING_PHONE_NUMBER.replace(/\d(?=\d{4})/g, "*"), // Mask most digits
        forwardingInProgress: true,
      });
    }

    const call = await twilioClient.calls(callSid).update({
      twiml: `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say>Transferring you to a human representative now. Please hold.</Say>
          <Dial callerId="${TWILIO_PHONE_NUMBER}" timeout="30" record="record-from-answer">
            ${FORWARDING_PHONE_NUMBER}
          </Dial>
          <Say>The call has ended. Thank you for your time.</Say>
          <Hangup/>
        </Response>`,
    });

    console.log(
      `[Twilio] ✓ Forward request sent successfully to Twilio API for call ${callSid}`
    );

    return call;
  } catch (error) {
    console.error(`[Twilio] ❌ Error forwarding call ${callSid}:`, error);

    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "completed";
      callInfo.completionReason = "forwarding_failed";
      callInfo.endTime = new Date();

      broadcastCallUpdate({
        callSid,
        status: "completed",
        completionReason: "forwarding_failed",
      });
    }

    throw error;
  }
}

function broadcastCallUpdate(callData) {
  const updateMessage = JSON.stringify({
    type: "call_status_update",
    ...callData,
  });

  console.log(
    `[Server] Broadcasting call update: ${callData.status} for ${callData.callSid}`
  );

  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(updateMessage);
    }
  }
}

async function getSignedUrl() {
  try {
    console.time("[ElevenLabs] Fetch signed URL");
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    console.timeEnd("[ElevenLabs] Fetch signed URL");
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

const recentCallAttempts = new Map();
const CALL_COOLDOWN = 60000;

fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  const now = Date.now();
  const lastAttempt = recentCallAttempts.get(number);

  if (lastAttempt && now - lastAttempt < CALL_COOLDOWN) {
    console.log(
      `[Server] Prevented duplicate call to ${number}, last attempt was ${
        (now - lastAttempt) / 1000
      }s ago`
    );
    return reply.code(429).send({
      success: false,
      error:
        "Rate limited. Please wait before trying to call this number again.",
      cooldownRemaining: Math.ceil(
        (CALL_COOLDOWN - (now - lastAttempt)) / 1000
      ),
    });
  }

  recentCallAttempts.set(number, now);

  setTimeout(() => {
    recentCallAttempts.delete(number);
  }, 3600000);

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,

      timeout: 15,
      machineDetection: "DetectMessageEnd",
      machineDetectionTimeout: 10,

      statusCallback: `https://${request.headers.host}/call-status-callback`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: "initiated",
      startTime: new Date(),
      prompt,
      first_message,
    });

    broadcastCallUpdate({
      callSid: call.sid,
      number,
      status: "initiated",
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call: " + error.message,
    });
  }
});

fastify.post("/forward-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;

  if (!callSid) {
    return reply.code(400).send({ error: "Call SID is required" });
  }

  try {
    await forwardCallToHuman(callSid);

    reply.send({
      success: true,
      message: "Call forwarded successfully",
      callSid,
    });
  } catch (error) {
    console.error(`Error forwarding call ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to forward call",
    });
  }
});

fastify.get("/call-status/:callSid", async (request, reply) => {
  const { callSid } = request.params;

  try {
    if (activeCalls.has(callSid)) {
      reply.send({
        success: true,
        call: activeCalls.get(callSid),
      });
      return;
    }

    const call = await twilioClient.calls(callSid).fetch();

    reply.send({
      success: true,
      call: {
        callSid: call.sid,
        status: call.status,
        duration: call.duration || 0,
        startTime: call.dateCreated,
        endTime: call.dateUpdated,
      },
    });
  } catch (error) {
    console.error(`Error fetching call status for ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to fetch call status",
    });
  }
});

fastify.post("/call-status-callback", async (request, reply) => {
  const { CallSid, CallStatus, CallDuration, AnsweredBy } = request.body;

  console.log(
    `[Twilio] Call ${CallSid} status update: ${CallStatus}, duration: ${CallDuration}s, answered by: ${
      AnsweredBy || "unknown"
    }`
  );
  console.log(`[Twilio] Full callback data:`, request.body);

  // When call is answered, immediately prefetch a signed URL if we don't have one
  if (CallStatus === "in-progress") {
    // Start prefetching URL in background to reduce delay
    getCachedSignedUrl().catch(console.error);
  }

  if (activeCalls.has(CallSid)) {
    const callInfo = activeCalls.get(CallSid);

    callInfo.duration = CallDuration || 0;

    if (callInfo.status === "forwarding" && CallStatus === "completed") {
      callInfo.status = "completed";
      callInfo.completionReason =
        callInfo.completionReason || "forwarded_call_ended";
      console.log(`[Twilio] Call ${CallSid} was forwarded and is now complete`);
    } else if (
      ["completed", "busy", "failed", "no-answer", "canceled"].includes(
        CallStatus
      )
    ) {
      callInfo.status = CallStatus;
      callInfo.endTime = new Date();

      console.log(
        `[Twilio] Call ${CallSid} reached terminal state: ${CallStatus}`
      );

      setTimeout(() => {
        console.log(`[Twilio] Removing call ${CallSid} from active calls map`);
        activeCalls.delete(CallSid);
      }, 3600000);
    } else {
      callInfo.status = CallStatus;
    }

    broadcastCallUpdate({
      callSid: CallSid,
      status: callInfo.status,
      duration: CallDuration || 0,
      completionReason: callInfo.completionReason,
      answeredBy: AnsweredBy,
    });
  }

  reply.send({ success: true });
});

fastify.post("/end-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;

  if (!callSid) {
    return reply.code(400).send({ error: "Call SID is required" });
  }

  try {
    await twilioClient.calls(callSid).update({
      status: "completed",
    });

    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "completed";
      callInfo.endTime = new Date();
      callInfo.manuallyEnded = true;

      broadcastCallUpdate({
        callSid,
        status: "completed",
        manuallyEnded: true,
      });
    }

    reply.send({
      success: true,
      message: "Call ended successfully",
    });
  } catch (error) {
    console.error(`Error ending call ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to end call",
    });
  }
});

// Helper function to get the appropriate base URL based on environment
function getPublicBaseUrl(request) {
  // fall back to headers if PUBLIC_HOST_URL isn’t set
  return process.env.PUBLIC_HOST_URL
    ? process.env.PUBLIC_HOST_URL
    : `https://${request.headers.host}`
}

fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || ""
  const first_message = request.query.first_message || ""

  // build ws URL from your HTTP/HTTPS base
  const raw = getPublicBaseUrl(request)
  const streamUrl = raw.replace(/^http/, "ws") + "/outbound-media-stream"

  console.log(`[Twilio] Stream URL → ${streamUrl}`)

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${streamUrl}">
          <Parameter name="prompt" value="${prompt}" />
          <Parameter name="first_message" value="${first_message}" />
        </Stream>
      </Connect>
    </Response>`

  reply.type("text/xml").send(twimlResponse)
})

// Create a diagnostic endpoint to verify WebSocket functionality
fastify.get("/diagnostics", async (request, reply) => {
  try {
    // Check if we can get a signed URL from ElevenLabs
    console.log("[Diagnostics] Testing ElevenLabs signed URL");
    let elevenLabsUrl = null;
    try {
      elevenLabsUrl = await getSignedUrl();
      console.log("[Diagnostics] Successfully obtained ElevenLabs signed URL");
    } catch (error) {
      console.error(
        "[Diagnostics] Failed to get ElevenLabs signed URL:",
        error
      );
    }

    // Check environment variables
    const envCheck = {
      ELEVENLABS_API_KEY: !!ELEVENLABS_API_KEY,
      ELEVENLABS_AGENT_ID: !!ELEVENLABS_AGENT_ID,
      TWILIO_ACCOUNT_SID: !!TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: !!TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER: !!TWILIO_PHONE_NUMBER,
      FORWARDING_PHONE_NUMBER: !!FORWARDING_PHONE_NUMBER,
      IS_AWS_ENV: IS_AWS_ENV,
      PORT: PORT,
      PUBLIC_HOST_URL: process.env.PUBLIC_HOST_URL || "Not set",
    };

    reply.send({
      status: "ok",
      time: new Date().toISOString(),
      environment: IS_AWS_ENV ? "aws" : "local",
      host: request.headers.host,
      elevenlabsUrlTest: !!elevenLabsUrl,
      environmentVariables: envCheck,
      activeWebSocketClients: wsClients.size,
      activeCalls: activeCalls.size,
      memoryUsage: process.memoryUsage(),
    });
  } catch (error) {
    console.error("[Diagnostics] Error generating diagnostics:", error);
    reply.code(500).send({
      status: "error",
      message: "Error generating diagnostics",
      error: error.message,
    });
  }
});

// Configure Fastify for AWS Elastic Beanstalk
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    {
      websocket: true,
      wsOptions: {
        // Increase timeouts for AWS environment
        pingInterval: 30000, // 30 seconds
        pingTimeout: 60000, // 60 seconds
        // Add any other necessary WebSocket server options
        perMessageDeflate: false, // Disable compression which can sometimes cause issues
      },
    },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Add ping/pong to keep connection alive on AWS
      const pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.ping();
            console.log("[WebSocket] Sent ping to keep connection alive");
          } catch (error) {
            console.error("[WebSocket] Error sending ping:", error);
          }
        } else {
          clearInterval(pingTimer);
        }
      }, 30000); // Every 30 seconds

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let conversationEnded = false;
      let elevenLabsSetupStarted = false;

      ws.on("error", (error) => {
        console.error("[WebSocket] Twilio stream error:", error);
      });

      const setupElevenLabs = async (useCache = true) => {
        if (elevenLabsSetupStarted) {
          console.log(
            "[ElevenLabs] Setup already in progress, skipping duplicate setup"
          );
          return;
        }

        elevenLabsSetupStarted = true;
        console.time("[Call Flow] ElevenLabs setup");

        try {
          // Use cached URL if available to reduce delay
          const signedUrl = useCache
            ? await getCachedSignedUrl()
            : await getSignedUrl();

          console.log(
            "[ElevenLabs] Got signed URL, establishing connection..."
          );

          // Add additional WebSocket connection options for stability in AWS environment
          const wsOptions = {
            handshakeTimeout: 15000, // 15 seconds
            headers: {
              "User-Agent": "Rankorbit-AI-Agent/1.0",
            },
          };

          elevenLabsWs = new WebSocket(signedUrl, wsOptions);

          // Add specific error event handler for connection issues
          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket connection error:", error);
            elevenLabsSetupStarted = false; // Reset so we can try again
          });

          // Add connection timeout handling
          const connectionTimeout = setTimeout(() => {
            if (elevenLabsWs.readyState !== WebSocket.OPEN) {
              console.error("[ElevenLabs] Connection timed out");
              elevenLabsWs.terminate();
              elevenLabsSetupStarted = false;
            }
          }, 15000);

          elevenLabsWs.on("open", () => {
            clearTimeout(connectionTimeout);
            console.timeEnd("[Call Flow] ElevenLabs setup");
            console.log("[ElevenLabs] Connected to Conversational AI");

            // If we have parameters already, send them immediately
            if (customParameters) {
              sendInitialConfig();
            }
          });

          // Function to send initial config to ElevenLabs
          function sendInitialConfig() {
            console.time("[Call Flow] Initial config to first audio");
            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                user_name: "User",
                user_id: Math.floor(Math.random() * 10000),
              },
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config with prompt:",
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            elevenLabsWs.send(JSON.stringify(initialConfig));
          }

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  // Log timing for first audio chunk received
                  if (!elevenLabsWs.receivedFirstAudio) {
                    console.timeEnd(
                      "[Call Flow] Initial config to first audio"
                    );
                    elevenLabsWs.receivedFirstAudio = true;
                  }

                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log(
                      "[ElevenLabs] Received audio but no StreamSid yet"
                    );
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(
                      JSON.stringify({
                        event: "clear",
                        streamSid,
                      })
                    );
                  }
                  break;

                // Add other cases for message types
                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(
                      JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id,
                      })
                    );
                  }
                  break;

                case "agent_response":
                  console.log(
                    `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                  );
                  break;

                case "user_transcript":
                  const userTranscript =
                    message.user_transcription_event?.user_transcript || "";
                  console.log(`[Twilio] User transcript: "${userTranscript}"`);

                  if (shouldTransferToHuman(userTranscript) && callSid) {
                    console.log(
                      `[Twilio] ✓ TRANSFER REQUESTED: "${userTranscript}"`
                    );

                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      console.log(`[Twilio] Sending interrupt to ElevenLabs`);

                      elevenLabsWs.send(
                        JSON.stringify({
                          type: "interrupt",
                        })
                      );

                      setTimeout(() => {
                        console.log(
                          `[Twilio] Sending transfer message to ElevenLabs`
                        );

                        elevenLabsWs.send(
                          JSON.stringify({
                            type: "user_message",
                            user_message_event: {
                              user_message:
                                "[SYSTEM_INSTRUCTION: User requested transfer to human. Say 'I'll transfer you to a human representative now. Please hold.' and then end the conversation.]",
                            },
                          })
                        );

                        setTimeout(async () => {
                          try {
                            console.log(
                              `[Twilio] Initiating transfer to human for call ${callSid}`
                            );
                            await forwardCallToHuman(callSid);
                          } catch (error) {
                            console.error(
                              `[Twilio] Error forwarding call:`,
                              error
                            );
                          }
                        }, 2000);
                      }, 300);
                    } else {
                      console.log(
                        `[Twilio] ElevenLabs not connected, forwarding immediately`
                      );
                      forwardCallToHuman(callSid).catch(console.error);
                    }
                  }
                  break;

                case "conversation_ended":
                  console.log(`[ElevenLabs] Conversation ended`);
                  conversationEnded = true;

                  if (callSid && activeCalls.has(callSid)) {
                    const callInfo = activeCalls.get(callSid);
                    callInfo.conversationEnded = true;

                    broadcastCallUpdate({
                      callSid,
                      status: "conversation_ended",
                      conversationEnded: true,
                    });
                  }
                  break;

                default:
                  console.log(
                    `[ElevenLabs] Unhandled message type: ${message.type}`
                  );
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
          elevenLabsSetupStarted = false; // Allow retry on failure
        }
      };

      // Start ElevenLabs setup as soon as Twilio connects
      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "connected":
              // Handle the previously unhandled "connected" event
              console.log("[Twilio] Media stream connected");
              break;

            case "start":
              console.time("[Call Flow] Start event to ElevenLabs ready");
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log("[Twilio] Start parameters:", customParameters);

              // Send config if ElevenLabs is already connected
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                console.log(
                  "[ElevenLabs] Connection already open, sending config immediately"
                );
                // Send initial config
                elevenLabsWs.send(
                  JSON.stringify({
                    type: "conversation_initiation_client_data",
                    dynamic_variables: {
                      user_name: "User",
                      user_id: Math.floor(Math.random() * 10000),
                    },
                    conversation_config_override: {
                      agent: {
                        prompt: {
                          prompt:
                            customParameters?.prompt ||
                            "you are a gary from the phone store",
                        },
                        first_message:
                          customParameters?.first_message ||
                          "hey there! how can I help you today?",
                      },
                    },
                  })
                );
              }

              if (activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.status = "in-progress";
                callInfo.streamSid = streamSid;

                broadcastCallUpdate({
                  callSid,
                  status: "in-progress",
                  streamSid,
                });
              }
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(
                    msg.media.payload,
                    "base64"
                  ).toString("base64"),
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);

              if (callSid && activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.streamEnded = true;
                callInfo.status = "completed";
                callInfo.endTime = new Date();

                broadcastCallUpdate({
                  callSid,
                  status: "completed",
                  streamEnded: true,
                });
              }

              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected from outbound media stream");

        if (callSid && activeCalls.has(callSid)) {
          const callInfo = activeCalls.get(callSid);
          callInfo.twilioDisconnected = true;
          callInfo.status = "completed";
          callInfo.endTime = new Date();

          broadcastCallUpdate({
            callSid,
            status: "completed",
            twilioDisconnected: true,
          });
        }

        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/call-status-ws",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Client connected to call status WebSocket");

      wsClients.add(connection);

      if (activeCalls.size > 0) {
        const activeCallsData = Array.from(activeCalls.values());
        connection.send(
          JSON.stringify({
            type: "active_calls",
            calls: activeCallsData,
          })
        );
      }

      connection.on("message", (message) => {
        console.log(
          "[WebSocket] Received message from client:",
          message.toString()
        );
      });

      connection.on("close", () => {
        console.log("[Server] Client disconnected from call status WebSocket");
        wsClients.delete(connection);
      });
    }
  );
});

function cleanupStalledCalls() {
  const now = new Date();
  const MAX_CALL_DURATION = 15 * 60 * 1000;

  for (const [callSid, callInfo] of activeCalls.entries()) {
    if (
      ["completed", "busy", "failed", "no-answer", "canceled"].includes(
        callInfo.status
      )
    ) {
      continue;
    }

    const startTime = new Date(callInfo.startTime);
    const callDuration = now - startTime;

    if (callDuration > MAX_CALL_DURATION) {
      console.log(
        `[Server] Auto-completing stalled call ${callSid} after ${
          callDuration / 1000
        }s`
      );

      callInfo.status = "completed";
      callInfo.completionReason = "timed_out";
      callInfo.endTime = now;

      broadcastCallUpdate({
        callSid,
        status: "completed",
        completionReason: "timed_out",
      });

      twilioClient
        .calls(callSid)
        .update({
          status: "completed",
        })
        .catch((error) => {
          console.error(
            `[Twilio] Error ending stalled call ${callSid}:`,
            error
          );
        });
    }
  }
}

setInterval(cleanupStalledCalls, 60000);

fastify.get("/health", async (_, reply) => {
  reply.send({ status: "ok", time: new Date().toISOString() });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
