import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand, DeleteTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { Buffer } from "buffer";
import { RecorderPCM } from './RecorderPCM'; // using the audio worklet
import { RecorderPCMSPN } from './RecorderPCMScriptNode'; // using the script processor node
import MicrophoneStream from "microphone-stream";

const AWS_REGION = "<AWS_REGION>";
const QUEUE_URL = "<QUEUE_URL>";
const FUNCTION_NAME = "<FUNCTION_NAME>";
const IDENTITY_POOL = "<IDEDNTITY_POOL_ID>";
const BATCH_BUCKET = "<S3_BATCH_BUCKET>";
const SAMPLE_RATE = 44100;
let transcribeClientStream, transcribeClient, pollyClient, s3Client, lambdaClient, sqsClient, microphoneStream, language, opponentLang, voiceId, translatedTxt;

/** Get the credentials using the cognito pool and the url+token from auth0
*/
const getCredentials = async () => {
    const cognitoClient = new CognitoIdentityClient({
        region: AWS_REGION
    });

    const credentials = await fromCognitoIdentityPool({
        client: cognitoClient,
        identityPoolId: IDENTITY_POOL
    })();

    return credentials;
}

const createMicrophoneStream = async () => {
    microphoneStream = new MicrophoneStream();
    microphoneStream.setStream(
        await window.navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true,
        })
    );
};

const encodePCMChunk = (chunk) => {
    const input = MicrophoneStream.toRaw(chunk);
    let offset = 0;
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < input.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return Buffer.from(buffer);
};

const getAudioStream = async function* () {
    for await (const chunk of microphoneStream) {
        if (chunk.length <= SAMPLE_RATE) {
            yield {
                AudioEvent: {
                    AudioChunk: encodePCMChunk(chunk),
                },
            };
        }
    }
};

const startStreaming = async (callback) => {
    console.log(language, ' LLL')
    const data = await transcribeClientStream.send(new StartStreamTranscriptionCommand({
        LanguageCode: language,
        MediaEncoding: "pcm",
        MediaSampleRateHertz: SAMPLE_RATE,
        AudioStream: getAudioStream(),
    }));
    for await (const event of data.TranscriptResultStream) {
        const results = event.TranscriptEvent.Transcript.Results;
        if (results.length && !results[0]?.IsPartial) {
            const newTranscript = results[0].Alternatives[0].Transcript;
            console.log(newTranscript);
            callback(newTranscript + " ");
        }
    }
};

const audioBufferToWav = function (audioBuffer) {
    const numOfChan = audioBuffer.numberOfChannels,
        length = audioBuffer.length * numOfChan * 2 + 44,
        buffer = new ArrayBuffer(length),
        view = new DataView(buffer),
        channels = [],
        sampleRate = audioBuffer.sampleRate,
        format = 1; // PCM

    // Write WAV header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + audioBuffer.length * numOfChan * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numOfChan, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, numOfChan * 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, audioBuffer.length * numOfChan * 2, true);

    // Write PCM samples
    let offset = 44;
    for (let i = 0; i < audioBuffer.length; i++) {
        for (let channel = 0; channel < numOfChan; channel++) {
            const sample = audioBuffer.getChannelData(channel)[i];
            const clamped = Math.max(-1, Math.min(1, sample));
            view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF, true);
            offset += 2;
        }
    }

    return buffer;

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }
}

// Translate foreign text to indonesia with aws bedrock
const translateTo = async () => {
    await lambdaClient.send(new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify({ transcription, language, opponentLang })
    }));
}

const receiveMsg = async () => {
    const message = await sqsClient.send(new ReceiveMessageCommand({ // SendMessageRequest
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 0,
        WaitTimeSeconds: 1
    }))
    console.log(message)

    if (message?.Messages?.length > 0) {
        const sqsBody = JSON.parse(message.Messages[0].Body);
        if (sqsBody.source !== language) {
            translatedTxt = JSON.parse(base64ToUtf8(sqsBody.msg)).text;
            opponentTxt.innerHTML = translatedTxt;
            console.log("Clean up the message")
            await Promise.all([
                sqsClient.send(new DeleteMessageCommand({
                    QueueUrl: QUEUE_URL,
                    ReceiptHandle: message.Messages[0].ReceiptHandle
                })),
                await startSpeech()
            ]);
        }
    }
    await receiveMsg();
}

const base64ToUtf8 = (base64) => {
    // Decode the base64 string to a binary string
    let binaryString = atob(base64);

    // Convert the binary string to a Uint8Array
    let binaryLength = binaryString.length;
    let bytes = new Uint8Array(binaryLength);
    for (let i = 0; i < binaryLength; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert the Uint8Array to a UTF-8 string
    let utf8String = new TextDecoder().decode(bytes);

    return utf8String;
}

const getJobStatus = async () => {
    const st = await transcribeClient.send(new GetTranscriptionJobCommand({
        TranscriptionJobName: "indonesia"
    }))
    if (st.TranscriptionJob.TranscriptionJobStatus === "IN_PROGRESS") {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(getJobStatus())
            }, 8000)
        })
    } else if (st.TranscriptionJob.TranscriptionJobStatus === "COMPLETED") {
        return st.TranscriptionJob.TranscriptionJobStatus;
    } else {
        return false;
    }
}

const startRecording = async (callback) => {
    if (microphoneStream || transcribeClient) {
        stopRecording();
    }
    createMicrophoneStream();
    await startStreaming(callback);
};

const stopRecording = function () {
    if (microphoneStream) {
        microphoneStream.stop();
        microphoneStream.destroy();
        microphoneStream = undefined;
    }
};

const startSpeech = async function () {
    const input = { // SynthesizeSpeechInput
        Engine: "neural",
        OutputFormat: "mp3", // required
        TextType: "text",
        Text: translatedTxt,
        VoiceId: voiceId, // required
        // VoiceId: "Aditi" || "Amy" || "Astrid" || "Bianca" || "Brian" || "Camila" || "Carla" || "Carmen" || "Celine" || "Chantal" || "Conchita" || "Cristiano" || "Dora" || "Emma" || "Enrique" || "Ewa" || "Filiz" || "Gabrielle" || "Geraint" || "Giorgio" || "Gwyneth" || "Hans" || "Ines" || "Ivy" || "Jacek" || "Jan" || "Joanna" || "Joey" || "Justin" || "Karl" || "Kendra" || "Kevin" || "Kimberly" || "Lea" || "Liv" || "Lotte" || "Lucia" || "Lupe" || "Mads" || "Maja" || "Marlene" || "Mathieu" || "Matthew" || "Maxim" || "Mia" || "Miguel" || "Mizuki" || "Naja" || "Nicole" || "Olivia" || "Penelope" || "Raveena" || "Ricardo" || "Ruben" || "Russell" || "Salli" || "Seoyeon" || "Takumi" || "Tatyana" || "Vicki" || "Vitoria" || "Zeina" || "Zhiyu" || "Aria" || "Ayanda" || "Arlet" || "Hannah" || "Arthur" || "Daniel" || "Liam" || "Pedro" || "Kajal" || "Hiujin" || "Laura" || "Elin" || "Ida" || "Suvi" || "Ola" || "Hala" || "Andres" || "Sergio" || "Remi" || "Adriano" || "Thiago" || "Ruth" || "Stephen" || "Kazuha" || "Tomoko" || "Niamh" || "Sofie" || "Lisa" || "Isabelle" || "Zayd" || "Danielle" || "Gregory" || "Burcu", // required
    };

    const command = new SynthesizeSpeechCommand(input);
    const resp = await pollyClient.send(command);
    const uInt8Arr = await resp.AudioStream.transformToByteArray();
    const arrayBuffer = uInt8Arr.buffer;
    const blob = new Blob([arrayBuffer]);
    const url = URL.createObjectURL(blob);
    audio.src = url;
    audio.play();
}

let recorder;
let context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
if (context.audioWorklet) // use the audio worklet if we can - it runs in its own thread and will be more reliable under heavy load
    recorder = new RecorderPCM;
else // fall back to the audio script processor node
    recorder = new RecorderPCMSPN;
const audio = document.querySelector("audio");
recorder.giveDataMethod(async data => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = audioContext.createBuffer(1, data[0].length, audioContext.sampleRate);
    audioBuffer.copyToChannel(data[0], 0);
    let ab = audioBufferToWav(audioBuffer);
    const audioBlob = new Blob([ab], { type: 'audio/wav' });
    // const url = URL.createObjectURL(audioBlob);

    await s3Client.send(new PutObjectCommand({
        Bucket: BATCH_BUCKET,
        Key: "idID.wav",
        Body: audioBlob,
        ContentType: 'audio/wav'
    }))

    await transcribeClient.send(new DeleteTranscriptionJobCommand({
        TranscriptionJobName: "indonesia"
    })).catch(e => {
        console.log(e.message)
    })

    await transcribeClient.send(new StartTranscriptionJobCommand({
        TranscriptionJobName: "indonesia",
        LanguageCode: "id-ID",
        MediaFormat: "wav",
        Media: {
            MediaFileUri: `https://${BATCH_BUCKET}.s3-${AWS_REGION}.amazonaws.com/idID.wav`,
        },
        OutputBucketName: BATCH_BUCKET
    }));

    const jobStatus = await getJobStatus();
    if (jobStatus) {
        const obj = await s3Client.send(new GetObjectCommand({
            Bucket: BATCH_BUCKET,
            Key: "indonesia.json"
        }))
        const j = await obj.Body.transformToString()
        const txt = JSON.parse(j).results.transcripts[0].transcript
        transcription = txt;
        transcriptionDiv.innerHTML = txt;
        await translateTo();
        transcription = "";
        transcriptionDiv.innerHTML = "";
    }
});
recorder.init().then(() => {
    console.log('recorder initialised');
}).catch(e => {
    console.error(e);
});

const nativeElm = document.getElementById("native");
const opponentElm = document.getElementById("opponent");
const talkButton = document.getElementById("talk");
const transcriptionDiv = document.getElementById("transcription");
const logoutBtn = document.getElementById("logout");
const opponentTxt = document.getElementById("opponentTxt");

let transcription = "";

nativeElm.addEventListener("change", async () => {
    language = nativeElm.value;
    if (language) {
        opponentElm.style.display = "block";
    } else {
        opponentElm.style.display = "none";
        document.getElementById("container").style.display = "none";
    }
})

opponentElm.addEventListener("change", async () => {
    opponentLang = opponentElm.value;
    if (opponentLang) {
        // Initialize the sdk clients with temp credentials
        getCredentials().then(async credentials => {
            transcribeClientStream = new TranscribeStreamingClient({
                region: AWS_REGION,
                credentials
            });
            transcribeClient = new TranscribeClient({
                region: AWS_REGION,
                credentials
            });
            pollyClient = new PollyClient({
                region: AWS_REGION,
                credentials
            });
            s3Client = new S3Client({
                region: AWS_REGION,
                credentials
            });
            lambdaClient = new LambdaClient({
                region: AWS_REGION,
                credentials
            })
            sqsClient = new SQSClient({
                region: AWS_REGION,
                credentials
            })

            if (language === "id-ID") {
                voiceId = "Laura";
            } else if (language === "hi-IN") {
                voiceId = "Kajal";
            } else if (language === "fr-FR") {
                voiceId = "Lea";
            } else {
                voiceId = "Joanna";
            }

            document.getElementById("container").style.display = "block";
            nativeElm.style.display = "none";
            opponentElm.style.display = "none";
            receiveMsg();
        })
    }
})

talkButton.addEventListener("click", async () => {
    if (talkButton.innerHTML === "Talk") {
        talkButton.innerHTML = "Stop";
        if (language === "id-ID") {
            recorder.start();
        } else {
            await startRecording((text) => {
                transcription += text;
                transcriptionDiv.innerHTML = transcription;
            });
        }
    } else {
        talkButton.innerHTML = "Talk";
        if (language === "id-ID") {
            recorder.stop()
        } else {
            stopRecording();
            await translateTo();
            transcription = "";
            transcriptionDiv.innerHTML = "";
        }
    }
});

logoutBtn.addEventListener("click", async () => {
    location.href = "/";
})