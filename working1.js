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

await fastify.register(fastifyCors, {
  origin: (origin, cb) => {
    if (!origin) {
      return cb(null, true);
    }
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://your-production-domain.com',
      origin
    ];
    
    if (allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    
    return cb(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Origin', 
    'X-Requested-With', 
    'Content-Type', 
    'Accept', 
    'Authorization'
  ],
  exposedHeaders: ['Content-Disposition'],
  credentials: true,
  maxAge: 3600,
  preflightContinue: false,
  optionsSuccessStatus: 204
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
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: 'initiated',
      startTime: new Date(),
      prompt,
      first_message
    });

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

const PORT = process.env.PORT || 3001;

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const activeCalls = new Map();
const wsClients = new Set();

function shouldTransferToHuman(transcript) {
  const cleanTranscript = transcript.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
  
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
    "talk with a human"
  ];
  
  for (const phrase of transferPhrases) {
    if (cleanTranscript.includes(phrase)) {
      console.log(`[Twilio] Transfer phrase detected: "${phrase}" in "${cleanTranscript}"`);
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
    console.log(`[Twilio] Transfer phrase detected in pattern: "${cleanTranscript}"`);
    return true;
  }
  
  return false;
}

async function forwardCallToHuman(callSid) {
  try {
    console.log(`[Twilio] ⚠️ FORWARDING CALL ${callSid} to human at ${FORWARDING_PHONE_NUMBER}`);
    
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = 'forwarding';
      callInfo.forwardingTime = new Date();
      callInfo.forwardingInProgress = true;
      
      broadcastCallUpdate({
        callSid,
        status: 'forwarding',
        forwardingTo: FORWARDING_PHONE_NUMBER.replace(/\d(?=\d{4})/g, "*"),
        forwardingInProgress: true
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
        </Response>`
    });
    
    console.log(`[Twilio] ✓ Forward request sent successfully to Twilio API for call ${callSid}`);
    
    return call;
  } catch (error) {
    console.error(`[Twilio] ❌ Error forwarding call ${callSid}:`, error);
    
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = 'completed';
      callInfo.completionReason = 'forwarding_failed';
      callInfo.endTime = new Date();
      
      broadcastCallUpdate({
        callSid,
        status: 'completed',
        completionReason: 'forwarding_failed'
      });
    }
    
    throw error;
  }
}

function broadcastCallUpdate(callData) {
  const updateMessage = JSON.stringify({
    type: 'call_status_update',
    ...callData
  });
  
  console.log(`[Server] Broadcasting call update: ${callData.status} for ${callData.callSid}`);
  
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

const recentCallAttempts = new Map();
const CALL_COOLDOWN = 60000;

fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  const now = Date.now();
  const lastAttempt = recentCallAttempts.get(number);
  
  if (lastAttempt && (now - lastAttempt) < CALL_COOLDOWN) {
    console.log(`[Server] Prevented duplicate call to ${number}, last attempt was ${(now - lastAttempt)/1000}s ago`);
    return reply.code(429).send({
      success: false,
      error: "Rate limited. Please wait before trying to call this number again.",
      cooldownRemaining: Math.ceil((CALL_COOLDOWN - (now - lastAttempt))/1000)
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
      machineDetection: 'DetectMessageEnd',
      machineDetectionTimeout: 10,
      statusCallback: `https://${request.headers.host}/call-status-callback`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });

    activeCalls.set(call.sid, {
      callSid: call.sid,
      number,
      status: 'initiated',
      startTime: new Date(),
      prompt,
      first_message
    });

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
      callSid
    });
  } catch (error) {
    console.error(`Error forwarding call ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to forward call"
    });
  }
});

fastify.get("/call-status/:callSid", async (request, reply) => {
  const { callSid } = request.params;
  
  try {
    if (activeCalls.has(callSid)) {
      reply.send({
        success: true,
        call: activeCalls.get(callSid)
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

fastify.post("/call-status-callback", async (request, reply) => {
  const { CallSid, CallStatus, CallDuration, AnsweredBy } = request.body;
  
  console.log(`[Twilio] Call ${CallSid} status update: ${CallStatus}, duration: ${CallDuration}s, answered by: ${AnsweredBy || 'unknown'}`);
  console.log(`[Twilio] Full callback data:`, request.body);
  
  if (activeCalls.has(CallSid)) {
    const callInfo = activeCalls.get(CallSid);
    
    callInfo.duration = CallDuration || 0;
    
    if (callInfo.status === 'forwarding' && CallStatus === 'completed') {
      callInfo.status = 'completed';
      callInfo.completionReason = callInfo.completionReason || 'forwarded_call_ended';
      console.log(`[Twilio] Call ${CallSid} was forwarded and is now complete`);
    } else if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(CallStatus)) {
      callInfo.status = CallStatus;
      callInfo.endTime = new Date();
      
      console.log(`[Twilio] Call ${CallSid} reached terminal state: ${CallStatus}`);
      
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
      answeredBy: AnsweredBy
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
      status: 'completed'
    });
    
    if (activeCalls.has(callSid)) {
      const callInfo = activeCalls.get(callSid);
      callInfo.status = 'completed';
      callInfo.endTime = new Date();
      callInfo.manuallyEnded = true;
      
      broadcastCallUpdate({
        callSid,
        status: 'completed',
        manuallyEnded: true
      });
    }
    
    reply.send({
      success: true,
      message: "Call ended successfully"
    });
  } catch (error) {
    console.error(`Error ending call ${callSid}:`, error);
    reply.code(500).send({
      success: false,
      error: "Failed to end call"
    });
  }
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
                    const userTranscript = message.user_transcription_event?.user_transcript || "";
                    console.log(`[Twilio] User transcript: "${userTranscript}"`);
                    
                    if (shouldTransferToHuman(userTranscript)) {
                      console.log(`[Twilio] ✓ TRANSFER REQUESTED: "${userTranscript}"`);
                      
                      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                        console.log(`[Twilio] Sending interrupt to ElevenLabs`);
                        
                        elevenLabsWs.send(JSON.stringify({
                          type: "interrupt"
                        }));
                        
                        setTimeout(() => {
                          console.log(`[Twilio] Sending transfer message to ElevenLabs`);
                          
                          elevenLabsWs.send(JSON.stringify({
                            type: "user_message",
                            user_message_event: {
                              user_message: "[SYSTEM_INSTRUCTION: User requested transfer to human. Say 'I'll transfer you to a human representative now. Please hold.' and then end the conversation.]"
                            }
                          }));
                          
                          setTimeout(async () => {
                            try {
                              console.log(`[Twilio] Initiating transfer to human for call ${callSid}`);
                              await forwardCallToHuman(callSid);
                            } catch (error) {
                              console.error(`[Twilio] Error forwarding call:`, error);
                            }
                          }, 2000);
                        }, 300);
                      } else {
                        console.log(`[Twilio] ElevenLabs not connected, forwarding immediately`);
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
            
            if (callSid && activeCalls.has(callSid)) {
              const callInfo = activeCalls.get(callSid);
              callInfo.elevenLabsDisconnected = true;
              
              if (callInfo.status === 'forwarding') {
                callInfo.status = 'completed';
                callInfo.completionReason = 'forwarded_to_human';
                callInfo.endTime = new Date();
              } else {
                callInfo.status = 'completed';
                callInfo.endTime = new Date();
                callInfo.completionReason = 'elevenlabs_disconnected';
              }
              
              broadcastCallUpdate({
                callSid,
                status: callInfo.status,
                elevenLabsDisconnected: true,
                completionReason: callInfo.completionReason
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
              
              if (activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.status = 'in-progress';
                callInfo.streamSid = streamSid;
                
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
              
              if (callSid && activeCalls.has(callSid)) {
                const callInfo = activeCalls.get(callSid);
                callInfo.streamEnded = true;
                callInfo.status = 'completed';
                callInfo.endTime = new Date();
                
                broadcastCallUpdate({
                  callSid,
                  status: 'completed',
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
        
        if (callSid && activeCalls.has(callSid)) {
          const callInfo = activeCalls.get(callSid);
          callInfo.twilioDisconnected = true;
          callInfo.status = 'completed';
          callInfo.endTime = new Date();
          
          broadcastCallUpdate({
            callSid,
            status: 'completed',
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

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/call-status-ws",
    { websocket: true },
    (connection, req) => {
      console.log("[Server] Client connected to call status WebSocket");
      
      wsClients.add(connection);
      
      if (activeCalls.size > 0) {
        const activeCallsData = Array.from(activeCalls.values());
        connection.send(JSON.stringify({
          type: 'active_calls',
          calls: activeCallsData
        }));
      }
      
      connection.on("message", (message) => {
        console.log("[WebSocket] Received message from client:", message.toString());
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
    if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(callInfo.status)) {
      continue;
    }
    
    const startTime = new Date(callInfo.startTime);
    const callDuration = now - startTime;
    
    if (callDuration > MAX_CALL_DURATION) {
      console.log(`[Server] Auto-completing stalled call ${callSid} after ${callDuration/1000}s`);
      
      callInfo.status = 'completed';
      callInfo.completionReason = 'timed_out';
      callInfo.endTime = now;
      
      broadcastCallUpdate({
        callSid,
        status: 'completed',
        completionReason: 'timed_out'
      });
      
      twilioClient.calls(callSid).update({
        status: 'completed'
      }).catch(error => {
        console.error(`[Twilio] Error ending stalled call ${callSid}:`, error);
      });
    }
  }
}

setInterval(cleanupStalledCalls, 60000);

fastify.get("/health", async (_, reply) => {
  reply.send({ status: "ok", time: new Date().toISOString() });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});