import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from "@aws-sdk/client-transcribe-streaming";
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand, DeleteTranscriptionJobCommand } from "@aws-sdk/client-transcribe";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { Buffer } from "buffer";
import { RecorderPCM } from '../RecorderPCM'; // using the audio worklet
import { RecorderPCMSPN } from '../RecorderPCMScriptNode'; // using the script processor node
import MicrophoneStream from "microphone-stream";

const AWS_REGION = "<AWS_REGION>";
const QUEUE_URL = "<QUEUE_URL>";
const FUNCTION_NAME = "<FUNCTION_NAME>";
const IDENTITY_POOL = "<IDEDNTITY_POOL_ID>";
const BATCH_BUCKET = "<S3_BATCH_BUCKET>";

const SAMPLE_RATE = 48000;
const voices = {
  "en-US": "Joanna",
  "fr-FR": "Lea",
  "hi-IN": "Kajal",
  "id-ID": "Joanna"
}
const is_chrome = navigator.userAgent.indexOf('Chrome') > -1;
const is_safari = navigator.userAgent.indexOf("Safari") > -1;

let transcribeClientStream, transcribeClient, pollyClient, s3Client, lambdaClient, sqsClient, microphoneStream, recorder;
const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
if (context.audioWorklet) // use the audio worklet if we can - it runs in its own thread and will be more reliable under heavy load
  recorder = new RecorderPCM;
else // fall back to the audio script processor node
  recorder = new RecorderPCMSPN;

import { LitElement, html, css } from 'lit';
import { Layouts } from '@collaborne/lit-flexbox-literals';
import '@material/mwc-button';
import '@material/mwc-circular-progress';
import '@material/mwc-list';
import '@material/mwc-select';
import '@material/mwc-snackbar';
import '@material/mwc-icon-button';

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
    console.log(chunk.length)
    if (chunk.length <= SAMPLE_RATE) {
      console.log("AA")
      yield {
        AudioEvent: {
          AudioChunk: encodePCMChunk(chunk),
        },
      };
    }
  }
};

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

class CommAi extends LitElement {
  static get properties() {
    return {
      viewTxt: { type: String },
      nativeLang: { type: String },
      opponentLang: { type: String }
    };
  }

  constructor() {
    super();
    this.viewTxt = "Hi mate, Welcome to Generative AI Tour 2024! Tell me, what's your preference languages please?";
  }

  static get styles() {
    return [
      Layouts,
      css`
      :host {
        display: block;
        margin: 5px;
        width: 95vw;
        height: 95vh;
      }
      img#sg2024 {
        height: 95vh;
      }
      img#mic {
        height: 30vh;
        display: none;
      }
      #startUI {
        display: none;
      }
      #question {
        font-weight: bold;
        font-size: 20px;
      }
      mwc-button#confirm {
        display: none;
      }
      mwc-button#talk {
        display: none;
      }
      #nativeLang {
        display: none;
      }
      #opponentLang {
        display: none;
      }
      mwc-icon-button {
        --mdc-icon-size: 50px;
        color: red;
        position: absolute;
        right: 10px;
        bottom: 10px;
        display: none;
      }
      @media only screen and (max-width: 1024px) {
        img#sg2024 {
          height: 50vh;
        }
      }
    `];
  }

  render() {
    return html`
    <div class="layout horizontal flex wrap center">
      <div><img id="sg2024" src="../images/SG2024.jpg"></div>
      <div class="layout horizontal flex">
        <mwc-button id="startUI" raised @click="${this.startUI}">Start</mwc-button>
        <div class="layout vertical">
          <div id="question"></div>
          <mwc-select id="nativeLang" label="Native Language">
            <mwc-list-item value="id-ID">Indonesia</mwc-list-item>
            <mwc-list-item value="hi-IN">Hindi</mwc-list-item>
            <mwc-list-item value="fr-FR">French</mwc-list-item>
            <mwc-list-item value="en-US">English</mwc-list-item>
          </mwc-select>
          <mwc-select id="opponentLang" label="Friend Language">
            <mwc-list-item value="id-ID">Indonesia</mwc-list-item>
            <mwc-list-item value="hi-IN">Hindi</mwc-list-item>
            <mwc-list-item value="fr-FR">French</mwc-list-item>
            <mwc-list-item value="en-US">English</mwc-list-item>
          </mwc-select>
          <mwc-button id="confirm" raised @click="${this.confirmLang}">Confirm</mwc-button>
          <img id="mic" src="https://media2.giphy.com/media/U2XyutfhyThfvhMKMH/giphy.gif?cid=6c09b9528t9btpweetnwqc1p2i94gh8nnqhpkx9his6k64fs&ep=v1_internal_gif_by_id&rid=giphy.gif&ct=s">
          <mwc-button id="talk" raised @click="${this.talkSend}">Talk</mwc-button>
        </div>
        <mwc-circular-progress indeterminate closed=true></mwc-circular-progress>
      </div>
    </div>
    <mwc-icon-button icon="logout" @click=${this.logout}></mwc-icon-button>
    <audio>
      <source class="track" src="" type="audio/mpeg">
    </audio>
    <mwc-snackbar></mwc-snackbar>
    `;
  }

  get viewTxtElm() {
    return this.shadowRoot.getElementById("question");
  }

  get audioElm() {
    return this.shadowRoot.querySelector("audio");
  }

  get micImg() {
    return this.shadowRoot.getElementById("mic");
  }

  get confirmBtn() {
    return this.shadowRoot.getElementById("confirm");
  }

  get talkBtn() {
    return this.shadowRoot.getElementById("talk");
  }

  get nativeSelect() {
    return this.shadowRoot.getElementById("nativeLang");
  }

  get opponentSelect() {
    return this.shadowRoot.getElementById("opponentLang");
  }

  get waitElm() {
    return this.shadowRoot.querySelector("mwc-circular-progress");
  }

  get feedback() {
    return this.shadowRoot.querySelector("mwc-snackbar");
  }

  firstUpdated() {
    this.getCredentials().then(async credentials => {
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

      this.shadowRoot.getElementById('startUI').style.display = "block";
    })
  }

  /** Get the credentials using the cognito pool and the url+token from auth0
  */
  async getCredentials() {
    const cognitoClient = new CognitoIdentityClient({
      region: AWS_REGION
    });

    const credentials = await fromCognitoIdentityPool({
      client: cognitoClient,
      identityPoolId: IDENTITY_POOL
    })();

    return credentials;
  }

  startUI() {
    this.waitElm.open();
    this.shadowRoot.getElementById("startUI").style.display = "none";
    this.startSpeech(this.viewTxt, "Joanna").then(() => {
      this.waitElm.close();
      this.viewTxtElm.innerHTML = this.viewTxt;
      this.nativeSelect.style.display = "block";
      this.opponentSelect.style.display = "block";
      this.confirmBtn.style.display = "block";
    })
  }

  async startSpeech(Text, VoiceId) {
    const input = { // SynthesizeSpeechInput
      Engine: "neural",
      OutputFormat: "mp3", // required
      TextType: "text",
      Text,
      VoiceId
    };

    const command = new SynthesizeSpeechCommand(input);
    const resp = await pollyClient.send(command);
    const uInt8Arr = await resp.AudioStream.transformToByteArray();
    const arrayBuffer = uInt8Arr.buffer;
    const blob = new Blob([arrayBuffer]);
    const url = URL.createObjectURL(blob);
    if (is_safari) {
      if (is_chrome) {
        this.audioElm.src = url;
        this.audioElm.pause();
        this.audioElm.currentTime = 0;
        this.audioElm.load();
      } else {
        this.audioElm.querySelector("source").src = url;
        this.audioElm.pause();
        this.audioElm.currentTime = 0;
        this.audioElm.load();
      }
    } else {
      this.audioElm.src = url;
    }
    this.audioElm.play();
  }

  confirmLang() {
    if (!this.nativeSelect.value || !this.opponentSelect.value) {
      this.feedback.labelText = "Please select the required fields above"
      return this.feedback.show();
    }
    if (this.nativeSelect.value === this.opponentSelect.value) {
      this.feedback.labelText = "Native could not same to Friend language"
      return this.feedback.show();
    }
    if (this.nativeSelect.value && this.opponentSelect.value) {
      this.audioElm.pause();
      this.audioElm.currentTime = 0;
      this.waitElm.open();
      this.nativeLang = this.nativeSelect.value;
      this.opponentLang = this.opponentSelect.value;
      this.nativeSelect.style.display = "none";
      this.opponentSelect.style.display = "none";
      this.confirmBtn.style.display = "none";
      this.viewTxtElm.innerHTML = "";
      this.viewTxt = "Yeay, setup done! Now, You are ready to talk with friend.";
      this.startSpeech(this.viewTxt, "Joanna").then(() => {
        this.waitElm.close();
        this.viewTxtElm.innerHTML = this.viewTxt;
        setTimeout(() => {
          this.viewTxtElm.innerHTML = "";
          this.talkBtn.style.display = "block";
          this.receiveMsg();
        }, 4500)
      })

      if (this.nativeLang === "id-ID") {
        recorder.giveDataMethod(async data => {
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const audioBuffer = audioContext.createBuffer(1, data[0].length, audioContext.sampleRate);
          audioBuffer.copyToChannel(data[0], 0);
          let ab = audioBufferToWav(audioBuffer);
          const audioBlob = new Blob([ab], { type: 'audio/wav' });

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
              MediaFileUri: "https://BATCH_BUCKET.s3-<AWS_REGION>.amazonaws.com/idID.wav",
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
            const text = JSON.parse(j).results.transcripts[0].transcript
            this.translateTo(text);
            this.viewTxtElm.innerHTML = this.viewTxt = `Send: ${text}`;
            this.talkBtn.style.display = "block";
            this.waitElm.close();
          }
        });
        recorder.init().then(() => {
          console.log('recorder initialised');
        }).catch(e => {
          console.error(e);
        });
      }

      this.shadowRoot.querySelector("mwc-icon-button").style.display = "block";
    }
  }

  talkSend() {
    this.viewTxtElm.innerHTML = this.viewTxt = "";
    this.talkBtn.style.display = "none";
    if (this.nativeLang === "id-ID") {
      recorder.start();
      this.startRecording(() => {
        recorder.stop()
        this.stopRecording();
        this.waitElm.open();
      })
    } else {
      this.startRecording((text) => {
        this.stopTalk(text);
      })
    }
  }

  stopTalk(text) {
    this.stopRecording();
    this.translateTo(text);
    this.viewTxtElm.innerHTML = this.viewTxt = `Send: ${text}`;
    this.talkBtn.style.display = "block";
  }

  async startRecording(callback) {
    if (microphoneStream || transcribeClient) {
      this.stopRecording();
    }
    await createMicrophoneStream();
    this.micImg.style.display = "block";
    await this.startStreaming(callback);
  };

  async stopRecording() {
    this.viewTxtElm.innerHTML = this.viewTxt = "";
    this.micImg.style.display = "none";
    if (microphoneStream) {
      microphoneStream.stop();
      microphoneStream.destroy();
      microphoneStream = undefined;
    }
  };

  async startStreaming(callback) {
    const data = await transcribeClientStream.send(new StartStreamTranscriptionCommand({
      LanguageCode: this.nativeLang === "id-ID" ? "en-US" : this.nativeLang,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: SAMPLE_RATE,
      AudioStream: getAudioStream(),
    }));
    for await (const event of data.TranscriptResultStream) {
      const results = event.TranscriptEvent.Transcript.Results;
      if (results.length && !results[0]?.IsPartial) {
        const newTranscript = results[0].Alternatives[0].Transcript;
        callback(newTranscript + " ");
      }
    }
  };

  translateTo(transcription) {
    lambdaClient.send(new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({ transcription, language: this.nativeLang, opponentLang: this.opponentLang })
    }));
  }

  async receiveMsg(WaitTimeSeconds = 2) {
    try {
      const message = await sqsClient.send(new ReceiveMessageCommand({ // SendMessageRequest
        QueueUrl: `${QUEUE_URL}-${this.nativeLang}`,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 0,
        WaitTimeSeconds
      }))
      console.log(message)

      if (message?.Messages?.length > 0) {
        this.waitElm.open();
        this.stopRecording();
        const sqsBody = JSON.parse(message.Messages[0].Body);
        this.viewTxt = JSON.parse(base64ToUtf8(sqsBody.msg)).text;
        console.log("Clean up the message")
        await Promise.all([
          sqsClient.send(new DeleteMessageCommand({
            QueueUrl: `${QUEUE_URL}-${this.nativeLang}`,
            ReceiptHandle: message.Messages[0].ReceiptHandle
          })),
          this.startSpeech(this.viewTxt, voices[this.nativeLang]).then(() => {
            this.viewTxtElm.innerHTML = `Receive: ${this.viewTxt}`;
            this.waitElm.close();
            this.talkBtn.style.display = "block";
          })
        ]);
      }
      if (WaitTimeSeconds === 2) {
        await this.receiveMsg(3);
      } else {
        await this.receiveMsg(2);
      }
    } catch(e) {
      if (WaitTimeSeconds === 2) {
        await this.receiveMsg(3);
      } else {
        await this.receiveMsg(2);
      }
    }
  }

  logout() {
    location.href = "/";
  }
}

window.customElements.define('comm-ai', CommAi);