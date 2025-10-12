const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');
const crypto = require('crypto');

// Native Node.js crypto implementation for SHA256
class Sha256 {
  constructor(secret) {
    this.secret = secret;
    this.hash = crypto.createHash('sha256');
  }

  update(data) {
    this.hash.update(data);
  }

  async digest() {
    return this.hash.digest();
  }
}

const dynamoClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);
const polly = new PollyClient({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const APPSYNC_API_ID = process.env.APPSYNC_API_ID;
const TTS_CHANNEL = process.env.TTS_CHANNEL;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// AppSync Events endpoint (use "events" subdomain for Events API)
const APPSYNC_ENDPOINT = `https://events.appsync-api.${AWS_REGION}.amazonaws.com/event`;

exports.handler = async (event) => {
  console.log('TTS handler event:', JSON.stringify(event, null, 2));
  
  try {
    // Parse request body (from Lambda Function URL or direct invocation)
    let messageData;
    if (event.body) {
      messageData = JSON.parse(event.body);
    } else {
      messageData = event;
    }
    
    const { text, language, sessionId, voiceId } = messageData;
    
    if (!text || !sessionId) {
      throw new Error('Missing required parameters: text, sessionId');
    }
    
    // Generate speech with Polly
    const audioData = await generateSpeech(text, voiceId || getDefaultVoice(language));
    
    // Store TTS result
    await storeTTSResult(sessionId, text, audioData);
    
    // Publish TTS result to AppSync Events
    await publishToAppSync(TTS_CHANNEL, sessionId, {
      type: 'tts_result',
      audioData,
      text,
      language,
      sessionId,
    });
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'TTS generated successfully',
        sessionId,
      }),
    };
  } catch (error) {
    console.error('Error in TTS handler:', error);
    
    // Publish error event to AppSync
    try {
      await publishToAppSync(TTS_CHANNEL, event.sessionId || 'unknown', {
        type: 'error',
        message: error.message,
        timestamp: Date.now(),
      });
    } catch (publishError) {
      console.error('Error publishing error event:', publishError);
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Internal server error' }),
    };
  }
};

async function generateSpeech(text, voiceId) {
  try {
    const command = new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: 'mp3',
      VoiceId: voiceId,
      Engine: 'neural',
      TextType: 'text',
    });
    
    const result = await polly.send(command);
    
    // Convert audio stream to base64
    const chunks = [];
    for await (const chunk of result.AudioStream) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);
    const audioBase64 = audioBuffer.toString('base64');
    
    return audioBase64;
  } catch (error) {
    console.error('Error generating speech:', error);
    throw new Error(`TTS generation failed: ${error.message}`);
  }
}

function getDefaultVoice(language) {
  const voiceMap = {
    'en-US': 'Joanna',
    'fr-FR': 'Lea',
    'hi-IN': 'Kajal',
    'id-ID': 'Joanna',
  };
  
  return voiceMap[language] || 'Joanna';
}

async function storeTTSResult(sessionId, text, audioData) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId,
        timestamp: Date.now(),
        type: 'tts',
        data: {
          text,
          audioData,
          timestamp: Date.now(),
        },
        ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days TTL
      },
    }));
  } catch (error) {
    console.error('Error storing TTS result:', error);
    throw error;
  }
}

/**
 * Publish event to AppSync Events API
 * @param {string} channel - Channel name (e.g., 'tts-events')
 * @param {string} namespace - Namespace for the event (typically sessionId)
 * @param {object} data - Event data payload
 */
async function publishToAppSync(channel, namespace, data) {
  try {
    const eventData = {
      channel: `${channel}/${namespace}`,
      events: [JSON.stringify(data)],
    };
    
    const url = new URL(APPSYNC_ENDPOINT);
    const request = new HttpRequest({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        host: url.hostname,
        'x-api-id': APPSYNC_API_ID,
      },
      body: JSON.stringify(eventData),
    });
    
    // Sign the request with AWS Signature V4
    const signer = new SignatureV4({
      service: 'appsync',
      region: AWS_REGION,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
    
    const signedRequest = await signer.sign(request);
    
    // Make the HTTP request
    const response = await fetch(`https://${signedRequest.hostname}${signedRequest.path}`, {
      method: signedRequest.method,
      headers: signedRequest.headers,
      body: signedRequest.body,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    console.log(`Published event to channel ${channel}/${namespace}:`, response.status);
    return data;
  } catch (error) {
    console.error('Error publishing to AppSync:', error);
    throw error;
  }
}
