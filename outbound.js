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
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
await fastify.register(fastifyCors, {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
});

const PORT = process.env.PORT || 3000;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Track active calls and clients
const activeCalls = new Map();
const wsClients = new Set();

// Function to broadcast call status updates to all connected clients
function broadcastCallUpdate(callData) {
  const updateMessage = JSON.stringify({
    type: 'call_status_update',
    ...callData
  });
  
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
fastify.post("/outbound-call", async (request, reply) => {
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
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    // Store call information
    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: 'initiated',
      startTime: new Date(),
      prompt,
      first_message
    });

    // Broadcast call initiation to all clients
    broadcastCallUpdate({
      callSid: call.sid,
      number,
      status: 'initiated'
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

// New endpoint to check call status
fastify.get("/call-status/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  
  try {
    // First check our local cache
    if (activeCalls.has(callSid)) {
      reply.send({
        success: true,
        call: activeCalls.get(callSid)
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
        endTime: call.dateUpdated
      }
    });
  } catch (error) {
    console.error(`Error fetching call status for ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to fetch call status"
    });
  }
});

// Add status callback endpoint
fastify.post("/call-status-callback", async (request, reply) => {
  const { CallSid, CallStatus, CallDuration } = request.body;
  
  console.log(`[Twilio] Call ${CallSid} status update: ${CallStatus}, duration: ${CallDuration}s`);
  
  // Update call status in our map
  if (activeCalls.has(CallSid)) {
    const callInfo = activeCalls.get(CallSid);
    callInfo.status = CallStatus;
    callInfo.duration = CallDuration || 0;
    
    // If call is complete, add end time
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) {
      callInfo.endTime = new Date();
      
      // Remove call from active calls after some time
      setTimeout(() => {
        activeCalls.delete(CallSid);
      }, 3600000); // Keep for 1 hour
    }
    
    // Broadcast update to all clients
    broadcastCallUpdate({
      callSid: CallSid,
      status: CallStatus,
      duration: CallDuration || 0
    });
  }
  
  reply.send({ success: true });
});

fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

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
                user_name: "Angelo",
                user_id: 1234,
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
                  console.log(
                    `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                  );
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
                      status: 'conversation_ended',
                      conversationEnded: true
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
              
              // Broadcast this information
              broadcastCallUpdate({
                callSid,
                status: callInfo.status,
                elevenLabsDisconnected: true
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
                callInfo.status = 'in-progress';
                callInfo.streamSid = streamSid;
                
                // Broadcast update
                broadcastCallUpdate({
                  callSid,
                  status: 'in-progress',
                  streamSid
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
                
                // Broadcast this information
                broadcastCallUpdate({
                  callSid,
                  status: callInfo.status,
                  streamEnded: true
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
          
          // Broadcast this information
          broadcastCallUpdate({
            callSid,
            status: callInfo.status,
            twilioDisconnected: true
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
        connection.send(JSON.stringify({
          type: 'active_calls',
          calls: activeCallsData
        }));
      }
      
      connection.on("message", (message) => {
        // Handle any client messages if needed
        console.log("[WebSocket] Received message from client:", message.toString());
      });
      
      connection.on("close", () => {
        console.log("[Server] Client disconnected from call status WebSocket");
        wsClients.delete(connection);
      });
    }
  );
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});