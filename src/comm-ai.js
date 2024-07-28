import { CognitoIdentityClient } from "@aws-sdk/client-cognito-identity";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { RecordRTCPromisesHandler } from 'recordrtc';

const AWS_REGION = import.meta.env.VITE_AWS_REGION;
const QUEUE_URL = import.meta.env.VITE_QUEUE_URL;
const FUNCTION_NAME = import.meta.env.VITE_FUNCTION_NAME;
const IDENTITY_POOL = import.meta.env.VITE_IDENTITY_POOL;

const voices = {
  "en-US": "Joanna",
  "fr-FR": "Lea",
  "hi-IN": "Kajal",
  "id-ID": "Joanna"
}
const is_chrome = navigator.userAgent.indexOf('Chrome') > -1;
const is_safari = navigator.userAgent.indexOf("Safari") > -1;
const AUDIO_TYPE = 'audio';
const asciiDecoder = new TextDecoder('ascii');

let pollyClient, lambdaClient, sqsClient, myTextIdx;

import { LitElement, html, css } from 'lit';
import { Layouts } from '@collaborne/lit-flexbox-literals';
import '@material/mwc-button';
import '@material/mwc-circular-progress';
import '@material/mwc-list';
import '@material/mwc-select';
import '@material/mwc-snackbar';
import '@material/mwc-textfield';
import '@material/mwc-icon-button';

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

class CommAi extends LitElement {
  static get properties() {
    return {
      sendTxt: { type: String },
      receiveTxt: { type: String },
      nativeLang: { type: String },
      recorder: { type: Object },
      stream: { type: Object },
      isRecording: { type: Boolean },
      isStopped: { type: Boolean },
      isPaused: { type: Boolean }
    };
  }

  constructor() {
    super();
    this.recorder = null;
    this.stream = null;
    this.isRecording = false;
    this.isStopped = true;
    this.isPaused = false;
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
      #sendMsg {
        font-weight: bold;
        font-size: 20px;
      }
      #receiveMsg {
        font-weight: bold;
        font-size: 20px;
        font-style: italic;
        color: blue;
      }
      mwc-button#talk {
        display: none;
      }
      mwc-button#send {
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
        <div class="layout vertical">
          <div id="sendMsg"></div>
          <mwc-textfield id="myName" placeholder="Nickname"></mwc-textfield>
          <mwc-select id="nativeLang" label="Native Language">
            <mwc-list-item value="id-ID">Indonesia</mwc-list-item>
            <mwc-list-item value="hi-IN">Hindi</mwc-list-item>
            <mwc-list-item value="fr-FR">French</mwc-list-item>
            <mwc-list-item value="en-US">English</mwc-list-item>
          </mwc-select>
          <mwc-button id="confirm" raised @click="${this.confirmProfile}" label='Confirm'></mwc-button>
          <img id="mic" src="https://media2.giphy.com/media/U2XyutfhyThfvhMKMH/giphy.gif?cid=6c09b9528t9btpweetnwqc1p2i94gh8nnqhpkx9his6k64fs&ep=v1_internal_gif_by_id&rid=giphy.gif&ct=s">
          <mwc-button id="talk" raised @click="${this.talkCmd}" label='Talk'></mwc-button>
          <mwc-button id="send" raised @click="${this.sendCmd}" label='Send'></mwc-button>
          <div id="receiveMsg"></div>
        </div>
        <mwc-circular-progress indeterminate closed=true></mwc-circular-progress>
      </div>
    </div>
    <audio>
      <source class="track" src="" type="audio/mpeg">
    </audio>
    <mwc-snackbar></mwc-snackbar>
    `;
  }

  get sendTxtElm() {
    return this.shadowRoot.getElementById("sendMsg");
  }

  get receiveTxtElm() {
    return this.shadowRoot.getElementById("receiveMsg");
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

  get sendBtn() {
    return this.shadowRoot.getElementById("send");
  }

  get myNameElm() {
    return this.shadowRoot.getElementById("myName");
  }

  get nativeSelect() {
    return this.shadowRoot.getElementById("nativeLang");
  }

  get waitElm() {
    return this.shadowRoot.querySelector("mwc-circular-progress");
  }

  get feedback() {
    return this.shadowRoot.querySelector("mwc-snackbar");
  }

  firstUpdated() {
    this.getCredentials().then(async credentials => {
      pollyClient = new PollyClient({
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

  // async pauseRecording() {
  //   if (!this.recorder) {
  //     this.feedback.labelText = 'Cannot pause recording: no recorder';
  //     return this.feedback.show();
  //   }
  //   await this.recorder.pauseRecording();
  //   this.isPaused = true;
  //   this.isRecording = false;
  // }

  // async resumeRecording() {
  //   if (!this.recorder) {
  //     this.feedback.labelText = 'Cannot resume recording: no recorder';
  //     return this.feedback.show();
  //   }
  //   await this.recorder.resumeRecording();
  //   this.isPaused = false;
  //   this.isRecording = true;
  // }

  async talkCmd() {
    try {
      this.sendTxtElm.innerHTML = this.sendTxt = "";
      this.talkBtn.style.display = "none";
      this.sendBtn.style.display = "block";
      this.micImg.style.display = "block";
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recorder = new RecordRTCPromisesHandler(this.stream, {
        type: AUDIO_TYPE,
      });
      this.recorder.startRecording();
      this.isRecording = true;
      this.isStopped = false;
    } catch (error) {
      this.isRecording = false;
      this.isStopped = true;
      this.feedback.labelText = `Error starting recording: ${error.message}`;
      return this.feedback.show();
    }
  }

  async sendCmd() {
    if (!this.isRecording || !this.recorder) {
      this.feedback.labelText = 'Cannot stop recording: no recorder';
      return this.feedback.show();
    }
    try {
      this.waitElm.open();
      this.micImg.style.display = "none";
      this.sendBtn.style.display = "none";
      await this.recorder.stopRecording();
      const blob = await this.recorder.getBlob();
      const transcribeRes = await this.transcribe(blob);
      const txtData = JSON.parse(asciiDecoder.decode(transcribeRes.Payload));
      this.sendTxtElm.innerHTML = this.sendTxt = `You: ${txtData}`;
      this.stream?.getTracks().forEach((track) => {
        track.stop();
      });
      this.recorder = null;
      this.stream = null;
      this.isRecording = false;
      this.isStopped = true;
      this.isPaused = false;
      this.talkBtn.style.display = "block";
      this.waitElm.close();
    } catch (error) {
      this.isRecording = false;
      this.isStopped = true;
      this.feedback.labelText = `Error stopping recording: ${error.message}`;
      return this.feedback.show();
    }
  }

  async transcribe(audioBlob) {
    try {
      const ab = await audioBlob.arrayBuffer();
      const arrayAb = Array.from(new Uint8Array(ab));
      return lambdaClient.send(new InvokeCommand({
        FunctionName: FUNCTION_NAME,
        Payload: JSON.stringify({ arrayAb, language: this.nativeLang, sender: this.myName })
      }));
    } catch (error) {
      this.feedback.labelText = `Error stopping recording: ${error.message}`;
      return this.feedback.show();
    }
  }

  confirmProfile() {
    if (!this.myNameElm.value || !this.nativeSelect.value) {
      this.feedback.labelText = "Please select the required fields above";
      return this.feedback.show();
    }

    this.myName = this.myNameElm.value;
    this.nativeLang = this.nativeSelect.value;

    this.nativeSelect.style.display = "none";
    this.myNameElm.style.display = "none";
    this.confirmBtn.style.display = "none";
    this.talkBtn.style.display = "block";
    myTextIdx = ["id-ID", "hi-IN", "fr-FR", "en-US"].findIndex(lidx => lidx === this.nativeLang);
    this.receiveMsg();
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

  async receiveMsg(WaitTimeSeconds = 2) {
    try {
      const message = await sqsClient.send(new ReceiveMessageCommand({ // SendMessageRequest
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 1,
        VisibilityTimeout: 0,
        WaitTimeSeconds
      }))

      if (message?.Messages?.length > 0) {
        const sqsBody = JSON.parse(message.Messages[0].Body) || "";
        if (sqsBody.source !== this.nativeLang) {
          const res = JSON.parse(base64ToUtf8(sqsBody.msg))?.text || "";
          this.receiveTxt = JSON.parse(res)?.[myTextIdx] || "";
          console.log("Clean up the message")
          await Promise.all([
            sqsClient.send(new DeleteMessageCommand({
              QueueUrl: `${QUEUE_URL}`,
              ReceiptHandle: message.Messages[0].ReceiptHandle
            })),
            this.startSpeech(this.receiveTxt, voices[this.nativeLang]).then(() => {
              this.receiveTxtElm.innerHTML = `${sqsBody.sender} (${sqsBody.source}): ${this.receiveTxt}`;
            })
          ]);
        }
      }
      if (WaitTimeSeconds === 2) {
        await this.receiveMsg(3);
      } else {
        await this.receiveMsg(2);
      }
    } catch (e) {
      if (WaitTimeSeconds === 2) {
        await this.receiveMsg(3);
      } else {
        await this.receiveMsg(2);
      }
    }
  }
}

window.customElements.define('comm-ai', CommAi);