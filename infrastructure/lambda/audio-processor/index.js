const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const FormData = require('form-data');
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
const bedrock = new BedrockRuntimeClient({});

const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID;
const APPSYNC_API_ID = process.env.APPSYNC_API_ID;
const TRANSCRIPTION_CHANNEL = process.env.TRANSCRIPTION_CHANNEL;
const TRANSLATION_CHANNEL = process.env.TRANSLATION_CHANNEL;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// AppSync Events endpoint (use "events" subdomain for Events API)
const APPSYNC_ENDPOINT = `https://events.appsync-api.${AWS_REGION}.amazonaws.com/event`;

exports.handler = async (event) => {
  console.log('Audio processor event:', JSON.stringify(event, null, 2));
  
  try {
    // Parse request body (from Lambda Function URL or direct invocation)
    let messageData;
    if (event.body) {
      messageData = JSON.parse(event.body);
    } else {
      messageData = event;
    }
    
    const { audioData, language, sessionId, chunkIndex, isLastChunk } = messageData;
    
    if (!audioData || !sessionId) {
      throw new Error('Missing required parameters: audioData, sessionId');
    }
    
    // Process audio chunk
    const result = await processAudioChunk(audioData, language, sessionId, chunkIndex);
    
    // Store processing result
    await storeProcessingResult(sessionId, chunkIndex, result, isLastChunk);
    
    // Publish transcription result to AppSync Events
    await publishToAppSync(TRANSCRIPTION_CHANNEL, sessionId, {
      type: 'transcription_result',
      chunkIndex,
      result,
      isLastChunk,
      sessionId,
    });
    
    // If this is the last chunk, trigger translation
    if (isLastChunk) {
      await triggerTranslation(sessionId);
    }
    
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: 'Audio processed successfully',
        sessionId,
        chunkIndex,
      }),
    };
  } catch (error) {
    console.error('Error in audio processor:', error);
    
    // Publish error event to AppSync
    try {
      await publishToAppSync(TRANSCRIPTION_CHANNEL, event.sessionId || 'unknown', {
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

async function processAudioChunk(audioData, language, sessionId, chunkIndex) {
  console.log(`Processing audio chunk ${chunkIndex} for session ${sessionId}`);
  
  try {
    // Convert base64 audio data to buffer
    const audioBuffer = Buffer.from(audioData, 'base64');
    
    // Transcribe with OpenAI Whisper
    const transcription = await transcribeWithWhisper(audioBuffer, language);
    
    return {
      transcription,
      language,
      timestamp: Date.now(),
      chunkIndex,
    };
  } catch (error) {
    console.error('Error processing audio chunk:', error);
    throw error;
  }
}

async function transcribeWithWhisper(audioBuffer, language) {
  try {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities', '["word"]');
    formData.append('language', language);
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data.text || '';
  } catch (error) {
    console.error('Error transcribing with Whisper:', error);
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

async function storeProcessingResult(sessionId, chunkIndex, result, isLastChunk) {
  try {
    await dynamodb.send(new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId,
        timestamp: Date.now(),
        chunkIndex,
        type: 'transcription',
        data: result,
        isLastChunk,
        ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days TTL
      },
    }));
  } catch (error) {
    console.error('Error storing processing result:', error);
    throw error;
  }
}

async function triggerTranslation(sessionId) {
  console.log(`Triggering translation for session ${sessionId}`);
  
  try {
    // Get all transcription chunks for this session
    const transcriptionChunks = await dynamodb.send(new QueryCommand({
      TableName: SESSIONS_TABLE,
      KeyConditionExpression: 'sessionId = :sessionId',
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: {
        '#type': 'type',
      },
      ExpressionAttributeValues: {
        ':sessionId': sessionId,
        ':type': 'transcription',
      },
      ScanIndexForward: true,
    }));
    
    // Combine all transcriptions
    const fullText = transcriptionChunks.Items
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(item => item.data.transcription)
      .join(' ');
    
    if (!fullText.trim()) {
      console.log('No text to translate');
      return;
    }
    
    // Translate using Bedrock
    const translation = await translateWithBedrock(fullText);
    
    // Store translation result
    await dynamodb.send(new PutCommand({
      TableName: SESSIONS_TABLE,
      Item: {
        sessionId,
        timestamp: Date.now(),
        type: 'translation',
        data: {
          originalText: fullText,
          translation,
          timestamp: Date.now(),
        },
        ttl: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days TTL
      },
    }));
    
    // Publish translation to AppSync Events
    await publishToAppSync(TRANSLATION_CHANNEL, sessionId, {
      type: 'translation_result',
      translation,
      originalText: fullText,
      sessionId,
    });
    
  } catch (error) {
    console.error('Error triggering translation:', error);
    throw error;
  }
}

async function translateWithBedrock(text) {
  try {
    const prompt = `Translate from the detected language to id-ID, hi-IN, fr-FR, en-US and I want the final result is split into single array and please don't add any intro. For example:
    input: "WHATEVER_TEXT"
    output: ["TEXT_IN_INDONESIA", "TEXT_IN_HINDI", "TEXT_IN_FRANCE", "TEXT_IN_ENGLISH_US"]

    The input is "${text}"`;
    
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };
    
    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json',
    });
    
    const response = await bedrock.send(command);
    const responseBody = JSON.parse(Buffer.from(response.body).toString());
    
    return responseBody.content[0].text;
  } catch (error) {
    console.error('Error translating with Bedrock:', error);
    throw new Error(`Translation failed: ${error.message}`);
  }
}

/**
 * Publish event to AppSync Events API
 * @param {string} channel - Channel name (e.g., 'transcription-events')
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
