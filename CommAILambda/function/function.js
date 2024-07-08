import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const config = require('./config.json');

const awsConfig = {
  region: config.region
}

const bedrockClient = new BedrockRuntimeClient(awsConfig);
const sqsClient = new SQSClient(awsConfig);

export const handler = async (event) => {
  try {
    const prompt = `Translate from ${event.language} to ${event.opponentLang}: ${event.transcription}`;
    const payload = {
      body: JSON.stringify({ message: prompt }),
      modelId: "cohere.command-r-plus-v1:0"
    };
    const response = await bedrockClient.send(new InvokeModelCommand(payload));
    const translateObj = Buffer.from(response.body).toString('base64');
    await sqsClient.send(new SendMessageCommand({ // SendMessageRequest
      QueueUrl: "<QUEUE_URL>",
      MessageBody: JSON.stringify({
        source: event.language,
        destination: event.opponentLang,
        msg: translateObj
      })
    }))
  } catch(e) {
    throw e;
  }
}
