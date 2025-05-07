import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";
import Fastify from "fastify";
import Twilio from "twilio";
import WebSocket from "ws";
import fastifyCors from "@fastify/cors";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  FORWARDING_PHONE_NUMBER, // New environment variable for forwarding
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

fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    if (!origin) {
      return cb(null, true);
    }

    // List of allowed origins
    const allowedOrigins = [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://rankorbit.ai",
      origin, 
    ];

    // Check if origin is in allowedOrigins
    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }

    // Optional: For development, you can allow all origins
    // return cb(null, true);

    return cb(null, true); // Currently allowing all origins for development
  },
  // Specify allowed methods
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  // Specify allowed headers
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
  ],
  // Expose these headers to the browser
  exposedHeaders: ["Content-Disposition"],
  // Allow credentials (cookies, authorization headers)
  credentials: true,
  // Cache preflight requests for 1 hour (3600 seconds)
  maxAge: 3600,
  // Handle preflight success response
  preflightContinue: false,
  // Success status for preflight responses
  optionsSuccessStatus: 204,
});

// Add new proxy endpoint to handle CORS issues
fastify.post("/proxy-outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    // Create call with status callbacks
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
      // Add status callback
      statusCallback: `https://${request.headers.host}/call-status-callback`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    // Store call information
    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: "initiated",
      startTime: new Date(),
      prompt,
      first_message,
    });

    // Broadcast call initiation to all clients
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

const PORT = process.env.PORT || 8080;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Track active calls and clients
const activeCalls = new Map();
const wsClients = new Set();

// Function to detect if the user wants to speak to a human
function shouldTransferToHuman(transcript) {
  // Strip punctuation and convert to lowercase for more reliable matching
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

  // More aggressive matching - check if ANY of these phrases appear ANYWHERE in the transcript
  for (const phrase of transferPhrases) {
    if (cleanTranscript.includes(phrase)) {
      console.log(
        `[Twilio] Transfer phrase detected: "${phrase}" in "${cleanTranscript}"`
      );
      return true;
    }
  }

  // Also detect "speak with" or "talk with" or "talk to" or "speak to" patterns
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

// Function to forward a call to a human representative
async function forwardCallToHuman(callSid) {
  try {
    console.log(
      `[Twilio] ⚠️ FORWARDING CALL ${callSid} to human at ${FORWARDING_PHONE_NUMBER}`
    );

    // Update the call status
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "forwarding";
      callInfo.forwardingTime = new Date();
      callInfo.forwardingInProgress = true;

      // Broadcast update to all clients
      broadcastCallUpdate({
        callSid,
        status: "forwarding",
        forwardingTo: FORWARDING_PHONE_NUMBER.replace(/\d(?=\d{4})/g, "*"), // Mask most digits
        forwardingInProgress: true,
      });
    }

    // Use Twilio's API to update the call with new TwiML
    // We're using a more direct TwiML that immediately dials without extra conversation
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

    // Update the call status to indicate forwarding failed
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "completed"; // Mark as completed even if forwarding failed
      callInfo.completionReason = "forwarding_failed";
      callInfo.endTime = new Date();

      // Broadcast the failure
      broadcastCallUpdate({
        callSid,
        status: "completed",
        completionReason: "forwarding_failed",
      });
    }

    throw error;
  }
}

// Function to broadcast call status updates to all connected clients
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
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// Updated outbound-call endpoint to include status callbacks

const recentCallAttempts = new Map();
const CALL_COOLDOWN = 60000; // 1 minute cooldown between calls to the same number

fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  // Check if we've recently attempted to call this number
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

  // Record this attempt
  recentCallAttempts.set(number, now);

  // Clean up old entries every hour
  setTimeout(() => {
    recentCallAttempts.delete(number);
  }, 3600000); // 1 hour

  try {
    // Create call with status callbacks
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
      // Set these parameters to reduce voicemail chances
      timeout: 15, // Hang up if no answer after 15 seconds
      machineDetection: "DetectMessageEnd", // Detect answering machines
      machineDetectionTimeout: 10, // Wait up to 10 seconds for machine detection
      // Add status callback
      statusCallback: `https://${request.headers.host}/call-status-callback`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });

    // Store call information
    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: "initiated",
      startTime: new Date(),
      prompt,
      first_message,
    });

    // Broadcast call initiation to all clients
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
// Manual forwarding endpoint
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

// New endpoint to check call status
fastify.get("/call-status/:callSid", async (request, reply) => {
  const { callSid } = request.params;

  try {
    // First check our local cache
    if (activeCalls.has(callSid)) {
      reply.send({
        success: true,
        call: activeCalls.get(callSid),
      });
      return;
    }

    // If not in cache, check with Twilio API
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

  // Update call status in our map
  if (activeCalls.has(CallSid)) {
    const callInfo = activeCalls.get(CallSid);

    // Always update duration
    callInfo.duration = CallDuration || 0;

    // Handle status update based on current state
    if (callInfo.status === "forwarding" && CallStatus === "completed") {
      // Call was forwarded and now completed
      callInfo.status = "completed";
      callInfo.completionReason =
        callInfo.completionReason || "forwarded_call_ended";
      console.log(`[Twilio] Call ${CallSid} was forwarded and is now complete`);
    } else if (
      ["completed", "busy", "failed", "no-answer", "canceled"].includes(
        CallStatus
      )
    ) {
      // Normal call completion states
      callInfo.status = CallStatus;
      callInfo.endTime = new Date();

      console.log(
        `[Twilio] Call ${CallSid} reached terminal state: ${CallStatus}`
      );

      // Remove call from active calls after some time
      setTimeout(() => {
        console.log(`[Twilio] Removing call ${CallSid} from active calls map`);
        activeCalls.delete(CallSid);
      }, 3600000); // Keep for 1 hour
    } else {
      // Other status updates
      callInfo.status = CallStatus;
    }

    // Broadcast update to all clients
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

// Add endpoint to end a call
fastify.post("/end-call/:callSid", async (request, reply) => {
  const { callSid } = request.params;

  if (!callSid) {
    return reply.code(400).send({ error: "Call SID is required" });
  }

  try {
    // Try to end the call via Twilio API
    await twilioClient.calls(callSid).update({
      status: "completed",
    });

    // Update our local tracking
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = "completed";
      callInfo.endTime = new Date();
      callInfo.manuallyEnded = true;

      // Broadcast the update
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

fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  // Simplified TwiML - direct connection to the media stream without Gather blocks
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
            <Stream url="wss://${request.headers.host}/outbound-media-stream">
                <Parameter name="prompt" value="${prompt}" />
                <Parameter name="first_message" value="${first_message}" />
            </Stream>
        </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ElevenLabs WebSocket handler
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;
      let conversationEnded = false;

      ws.on("error", console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              dynamic_variables: {
                user_name: "User", // More generic name
                user_id: Math.floor(Math.random() * 10000), // Random ID to avoid conflicts
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
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);
          
              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;
          
                case "audio":
                  if (streamSid) {
                    console.log("[ElevenLabs] Audio message received, format properties:", 
                      JSON.stringify({
                        hasAudioChunk: !!message.audio?.chunk,
                        hasAudioEventBase64: !!message.audio_event?.audio_base_64,
                        messageKeys: Object.keys(message)
                      })
                    );
                    
                    // Try to determine the audio structure
                    let payload = null;
                    
                    if (message.audio?.chunk) {
                      payload = message.audio.chunk;
                      console.log("[ElevenLabs] Using audio.chunk format");
                    } else if (message.audio_event?.audio_base_64) {
                      payload = message.audio_event.audio_base_64;
                      console.log("[ElevenLabs] Using audio_event.audio_base_64 format");
                    } else if (typeof message.audio === 'string') {
                      payload = message.audio;
                      console.log("[ElevenLabs] Using direct audio string format");
                    } else if (message.chunk) {
                      payload = message.chunk;
                      console.log("[ElevenLabs] Using direct chunk format");
                    }
                    
                    if (payload) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: payload,
                        },
                      };
                      ws.send(JSON.stringify(audioData));
                    } else {
                      console.log("[ElevenLabs] Could not determine audio payload format:", message);
                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
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
          
                  // Check if user wants to talk to a human - with enhanced logging
                  if (shouldTransferToHuman(userTranscript)) {
                    console.log(
                      `[Twilio] ✓ TRANSFER REQUESTED: "${userTranscript}"`
                    );
          
                    // Let the AI say goodbye
                    if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                      console.log(`[Twilio] Sending interrupt to ElevenLabs`);
          
                      elevenLabsWs.send(
                        JSON.stringify({
                          type: "interrupt",
                        })
                      );
          
                      // Wait a short time for any current audio to finish
                      setTimeout(() => {
                        // Send a message to ElevenLabs to say goodbye
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
          
                        // Immediately initiate the forwarding process with a shorter delay
                        // Don't wait for AI to respond, as it may not
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
                        }, 2000); // Reduced from 5000 to 2000
                      }, 300);
                    } else {
                      // If ElevenLabs connection isn't open, forward immediately
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
          
                  // Update call status if possible
                  if (callSid && activeCalls.has(callSid)) {
                    const callInfo = activeCalls.get(callSid);
                    callInfo.conversationEnded = true;
          
                    // Broadcast this information
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

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");

            // Update call status if possible
            if (callSid && activeCalls.has(callSid)) {
              const callInfo = activeCalls.get(callSid);
              callInfo.elevenLabsDisconnected = true;

              // If the call is in forwarding state, mark it as completed when ElevenLabs disconnects
              if (callInfo.status === "forwarding") {
                callInfo.status = "completed";
                callInfo.completionReason = "forwarded_to_human";
                callInfo.endTime = new Date();
              } else {
                // THIS IS THE CHANGE: Set status to 'completed' when ElevenLabs disconnects
                callInfo.status = "completed";
                callInfo.endTime = new Date();
                callInfo.completionReason = "elevenlabs_disconnected";
              }

              // Broadcast this information with the updated status
              broadcastCallUpdate({
                callSid,
                status: callInfo.status,
                elevenLabsDisconnected: true,
                completionReason: callInfo.completionReason,
              });
            }
          });
        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          if (msg.event !== "media") {
            console.log(`[Twilio] Received event: ${msg.event}`);
          }

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log("[Twilio] Start parameters:", customParameters);

              // Update call status if we have it
              if (activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.status = "in-progress";
                callInfo.streamSid = streamSid;

                // Broadcast update
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

              // Update call status if possible
              if (callSid && activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.streamEnded = true;
                callInfo.status = "completed"; // Mark call as completed when Twilio stops
                callInfo.endTime = new Date();

                // Broadcast this information
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

        // Update call status if possible
        if (callSid && activeCalls.has(callSid)) {
          const callInfo = activeCalls.get(callSid);
          callInfo.twilioDisconnected = true;
          callInfo.status = "completed";
          callInfo.endTime = new Date();

          // Broadcast this information
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

// Add WebSocket endpoint for call status updates
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/call-status-ws",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Client connected to call status WebSocket");

      // Add to clients list
      wsClients.add(connection);

      // Send initial active calls data
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
        // Handle any client messages if needed
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
  const MAX_CALL_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

  for (const [callSid, callInfo] of activeCalls.entries()) {
    // Skip calls that are already completed
    if (
      ["completed", "busy", "failed", "no-answer", "canceled"].includes(
        callInfo.status
      )
    ) {
      continue;
    }

    const startTime = new Date(callInfo.startTime);
    const callDuration = now - startTime;

    // If call has been going for more than MAX_CALL_DURATION, mark it as completed
    if (callDuration > MAX_CALL_DURATION) {
      console.log(
        `[Server] Auto-completing stalled call ${callSid} after ${
          callDuration / 1000
        }s`
      );

      callInfo.status = "completed";
      callInfo.completionReason = "timed_out";
      callInfo.endTime = now;

      // Broadcast update
      broadcastCallUpdate({
        callSid,
        status: "completed",
        completionReason: "timed_out",
      });

      // Try to end the call via Twilio
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

// Add health check endpoint
fastify.get("/health", async (_, reply) => {
  reply.send({ status: "ok", time: new Date().toISOString() });
});

// Start the server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
