import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import FormData from "form-data";
import axios from "axios";

const config = require('./config.json');

const awsConfig = {
  region: config.region
}

const bedrockClient = new BedrockRuntimeClient(awsConfig);
const sqsClient = new SQSClient(awsConfig);

// initial openai headers
const headers = {
  "Authorization": `Bearer ${config.openaiKey}`,
  "Content-Type": "multipart/form-data"
}


export const handler = async (event) => {
  try {
    // trascribe with openai
    const uint8 = Uint8Array.from(event.arrayAb);
    const audioBlob = Buffer.from(uint8);
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.wav");
    formData.append("model", config.openaiModel);
    const openAiRes = await axios.post(config.openaiUrl, formData, {
      headers
    });
    const transcribeRes = openAiRes.data?.text || "";
    // now translate the text with bedrock
    const prompt = `Translate from ${event.language} to id-ID, hi-IN, fr-FR, en-US and I want the final result is splitted into single array and please don't add any intro. For example:
    input: "WHATEVER_TEXT"
    output: ["TEXT_IN_INDONESIA", "TEXT_IN_HINDI", "TEXT_IN_FRANCE", "TEXT_IN_ENGLISH_US"]

    The input is "${transcribeRes}"`
    const payload = {
      body: JSON.stringify({ message: prompt }),
      modelId: config.aiModel
    };
    const response = await bedrockClient.send(new InvokeModelCommand(payload));
    const translateObj = Buffer.from(response.body).toString('base64');
    await sqsClient.send(new SendMessageCommand({ // SendMessageRequest
      QueueUrl: config.queueUrl,
      MessageBody: JSON.stringify({
        source: event.language,
        sender: event.sender,
        msg: translateObj
      })
    }))

    return transcribeRes;
  } catch(e) {
    throw e;
  }
}
