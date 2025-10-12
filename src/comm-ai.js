import { AppSyncEventsClient } from './appsync-events-client.js';
import { KVSWebRTCClient } from './kvs-webrtc-client.js';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';

const AWS_REGION = import.meta.env.VITE_AWS_REGION;
const APPSYNC_API_ID = import.meta.env.VITE_APPSYNC_API_ID;
const APPSYNC_API_KEY = import.meta.env.VITE_APPSYNC_API_KEY;
const AUDIO_PROCESSOR_URL = import.meta.env.VITE_AUDIO_PROCESSOR_URL;
const TTS_HANDLER_URL = import.meta.env.VITE_TTS_HANDLER_URL;
const TRANSCRIPTION_CHANNEL = import.meta.env.VITE_TRANSCRIPTION_CHANNEL || 'transcription-events';
const TRANSLATION_CHANNEL = import.meta.env.VITE_TRANSLATION_CHANNEL || 'translation-events';
const TTS_CHANNEL = import.meta.env.VITE_TTS_CHANNEL || 'tts-events';
const KVS_CHANNEL_ARN = import.meta.env.VITE_KVS_CHANNEL_ARN;
const KVS_CHANNEL_NAME = import.meta.env.VITE_KVS_CHANNEL_NAME || 'borderless-voice-comm-signaling';
const IDENTITY_POOL_ID = import.meta.env.VITE_IDENTITY_POOL_ID;

const voices = {
  "en-US": "Joanna",
  "fr-FR": "Lea",
  "hi-IN": "Kajal",
  "id-ID": "Joanna"
}

const is_chrome = navigator.userAgent.indexOf('Chrome') > -1;
const is_safari = navigator.userAgent.indexOf("Safari") > -1;
const AUDIO_TYPE = 'audio';

// Audio chunking configuration
const CHUNK_DURATION_MS = 2000; // 2 seconds per chunk
const CHUNK_OVERLAP_MS = 500; // 500ms overlap between chunks

let myTextIdx, appSyncClient, kvsClient, sessionId, isProcessingAudio;

import { LitElement, html, css } from 'lit';
import { Layouts } from '@collaborne/lit-flexbox-literals';
import '@material/mwc-button';
import '@material/mwc-circular-progress';
import '@material/mwc-list';
import '@material/mwc-select';
import '@material/mwc-snackbar';
import '@material/mwc-textfield';
import '@material/mwc-icon-button';

// Utility functions for WebSocket communication
const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const base64ToBlob = (base64, mimeType) => {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

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
      isPaused: { type: Boolean },
      isConnected: { type: Boolean },
      sessionId: { type: String },
      isInCall: { type: Boolean },
      remotePeerId: { type: String },
      callStatus: { type: String }
    };
  }

  constructor() {
    super();
    this.recorder = null;
    this.stream = null;
    this.isRecording = false;
    this.isStopped = true;
    this.isPaused = false;
    this.isConnected = false;
    this.sessionId = null;
    this.isProcessingAudio = false;
    this.isInCall = false;
    this.remotePeerId = null;
    this.callStatus = 'idle'; // idle, calling, in-call, ended
    this.audioChunkCounter = 0;
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
      #wrapper {
        width: 100%;
        height: 100%;
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
      #connectionStatus {
        font-size: 12px;
        color: #666;
        margin-bottom: 10px;
      }
      #connectionStatus.connected {
        color: green;
      }
      #connectionStatus.disconnected {
        color: red;
      }
      #callControls {
        display: none;
        margin-top: 20px;
      }
      #callStatus {
        font-size: 14px;
        margin: 10px 0;
        font-weight: bold;
      }
      #callStatus.in-call {
        color: green;
      }
      #callStatus.calling {
        color: orange;
      }
      mwc-button.call-btn {
        margin: 5px;
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
    <div id="wrapper" class="layout horizontal flex center-center center">
      <div class="layout vertical">
        <div id="connectionStatus" class="disconnected">Disconnected</div>
        <div id="sendMsg"></div>
        <mwc-textfield id="myName" placeholder="Nickname"></mwc-textfield>
        <mwc-select id="nativeLang" label="Native Language">
          <mwc-list-item value="id-ID">Indonesia</mwc-list-item>
          <mwc-list-item value="hi-IN">Hindi</mwc-list-item>
          <mwc-list-item value="fr-FR">French</mwc-list-item>
          <mwc-list-item value="en-US">English</mwc-list-item>
        </mwc-select>
        <mwc-button id="confirm" raised @click="${this.confirmProfile}" label='Confirm'></mwc-button>
        
        <!-- Call Controls -->
        <div id="callControls">
          <div id="callStatus" class="${this.callStatus}">${this.getCallStatusText()}</div>
          <mwc-button id="startCall" class="call-btn" raised @click="${this.startCall}" label='Start Call (Master)' ?disabled="${this.isInCall}"></mwc-button>
          <mwc-button id="joinCall" class="call-btn" raised @click="${this.joinCall}" label='Join Call (Viewer)' ?disabled="${this.isInCall}"></mwc-button>
          <mwc-button id="endCall" class="call-btn" raised @click="${this.endCall}" label='End Call' ?disabled="${!this.isInCall}"></mwc-button>
        </div>
        
        <img id="mic" src="https://media2.giphy.com/media/U2XyutfhyThfvhMKMH/giphy.gif?cid=6c09b9528t9btpweetnwqc1p2i94gh8nnqhpkx9his6k64fs&ep=v1_internal_gif_by_id&rid=giphy.gif&ct=s">
        <div id="receiveMsg"></div>
      </div>
      <mwc-circular-progress indeterminate closed=true></mwc-circular-progress>
    </div>
    <audio id="localAudio" autoplay muted></audio>
    <audio id="remoteAudio" autoplay></audio>
    <audio id="ttsAudio">
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
    return this.shadowRoot.getElementById("ttsAudio");
  }

  get localAudioElm() {
    return this.shadowRoot.getElementById("localAudio");
  }

  get remoteAudioElm() {
    return this.shadowRoot.getElementById("remoteAudio");
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

  get connectionStatusElm() {
    return this.shadowRoot.getElementById("connectionStatus");
  }

  get callControlsElm() {
    return this.shadowRoot.getElementById("callControls");
  }

  get remotePeerIdInput() {
    return this.shadowRoot.getElementById("remotePeerIdInput");
  }

  getCallStatusText() {
    switch (this.callStatus) {
      case 'idle': return 'Ready to call';
      case 'calling': return 'Calling...';
      case 'in-call': return '✓ In Call';
      case 'ended': return 'Call ended';
      default: return 'Ready';
    }
  }

  firstUpdated() {
    this.connectWebSocket();
  }

  async connectWebSocket() {
    try {
      // Generate a unique session ID
      this.sessionId = sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      // Create AppSync Events client (only for transcription/translation results)
      appSyncClient = new AppSyncEventsClient({
        apiId: APPSYNC_API_ID,
        region: AWS_REGION,
        apiKey: APPSYNC_API_KEY,
        sessionId: this.sessionId,
        channels: [
          TRANSCRIPTION_CHANNEL, 
          TRANSLATION_CHANNEL, 
          TTS_CHANNEL
        ],
      });
      
      // Set up message handlers
      appSyncClient.on(TRANSCRIPTION_CHANNEL, (event) => this.handleTranscriptionResult(event));
      appSyncClient.on(TRANSLATION_CHANNEL, (event) => this.handleTranslationResult(event));
      appSyncClient.on(TTS_CHANNEL, (event) => this.handleTTSResult(event));
      
      // Connect to AppSync Events
      await appSyncClient.connect();
      
      console.log('AppSync Events connected');
      this.isConnected = true;
      this.updateConnectionStatus('Connected', 'connected');
      
    } catch (error) {
      console.error('Error connecting to AppSync Events:', error);
      this.feedback.labelText = `Connection error: ${error.message}`;
      this.feedback.show();
      
      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        if (!this.isConnected) {
          this.connectWebSocket();
        }
      }, 3000);
    }
  }

  /**
   * Initialize KVS WebRTC client
   * MUCH simpler - AWS handles everything!
   */
  async initializeKVS(role = 'VIEWER') {
    try {
      // Get AWS credentials (using Cognito Identity Pool for guests)
      const credentials = fromCognitoIdentityPool({
        client: new CognitoIdentityClient({ region: AWS_REGION }),
        identityPoolId: IDENTITY_POOL_ID,
      });
      
      // Create KVS WebRTC client
      kvsClient = new KVSWebRTCClient({
        region: AWS_REGION,
        channelARN: KVS_CHANNEL_ARN,
        channelName: KVS_CHANNEL_NAME,
        credentials,
        role, // MASTER or VIEWER
        clientId: this.myName || `user_${Date.now()}`,
        onRemoteStream: (stream) => {
          console.log('Received remote stream');
          this.handleRemoteStream(stream);
        },
        onConnected: () => {
          console.log('Connected to peer');
          this.callStatus = 'in-call';
          this.isInCall = true;
          this.micImg.style.display = "block";
          this.requestUpdate();
        },
        onDisconnected: () => {
          console.log('Disconnected from peer');
          this.callStatus = 'ended';
          this.isInCall = false;
          this.micImg.style.display = "none";
          this.requestUpdate();
        },
        onError: (error) => {
          console.error('KVS WebRTC error:', error);
          this.feedback.labelText = `Error: ${error.message}`;
          this.feedback.show();
        },
        onAudioChunk: (audioData) => {
          // Process audio for transcription
          this.processAudioChunkForTranscription(audioData);
        },
      });
      
      // Start KVS WebRTC (AWS handles all the complexity!)
      await kvsClient.start();
      
      // Set local audio to element
      if (this.localAudioElm && kvsClient.localStream) {
        this.localAudioElm.srcObject = kvsClient.localStream;
      }
      
      console.log('KVS WebRTC initialized as', role);
    } catch (error) {
      console.error('Error initializing KVS:', error);
      this.feedback.labelText = `KVS initialization error: ${error.message}`;
      this.feedback.show();
      throw error;
    }
  }

  updateConnectionStatus(text, className) {
    if (this.connectionStatusElm) {
      this.connectionStatusElm.textContent = text;
      this.connectionStatusElm.className = className;
    }
  }

  handleRemoteStream(stream) {
    console.log('Setting up remote audio stream');
    
    if (this.remoteAudioElm) {
      this.remoteAudioElm.srcObject = stream;
    }
  }

  async processAudioChunkForTranscription(audioData) {
    if (!this.isInCall) return;
    
    // Throttle: send every Nth chunk for transcription
    this.audioChunkCounter++;
    if (this.audioChunkCounter % 10 !== 0) return; // Send every 10th chunk (~2 seconds at 2048 samples)
    
    try {
      // Convert ArrayBuffer to base64
      const base64Audio = btoa(
        String.fromCharCode.apply(null, new Uint8Array(audioData))
      );
      
      // Send to audio processor for transcription
      await this.invokeAudioProcessor(base64Audio, this.audioChunkCounter, false);
    } catch (error) {
      console.error('Error processing audio chunk:', error);
    }
  }

  /**
   * Start call as MASTER
   * Simpler with KVS - just initialize as MASTER!
   */
  async startCall() {
    try {
      this.callStatus = 'calling';
      this.waitElm.open();
      this.requestUpdate();
      
      // Initialize KVS as MASTER (initiator)
      await this.initializeKVS('MASTER');
      
      this.waitElm.close();
      console.log('Call started as MASTER');
      
    } catch (error) {
      console.error('Error starting call:', error);
      this.feedback.labelText = `Error starting call: ${error.message}`;
      this.feedback.show();
      this.callStatus = 'idle';
      this.waitElm.close();
      this.requestUpdate();
    }
  }

  /**
   * Join call as VIEWER
   * The other user must have started as MASTER first
   */
  async joinCall() {
    try {
      this.callStatus = 'calling';
      this.waitElm.open();
      this.requestUpdate();
      
      // Initialize KVS as VIEWER (joiner)
      await this.initializeKVS('VIEWER');
      
      this.waitElm.close();
      console.log('Joined call as VIEWER');
      
    } catch (error) {
      console.error('Error joining call:', error);
      this.feedback.labelText = `Error joining call: ${error.message}`;
      this.feedback.show();
      this.callStatus = 'idle';
      this.waitElm.close();
      this.requestUpdate();
    }
  }

  /**
   * End call
   * Much simpler - just stop KVS client
   */
  async endCall() {
    if (!kvsClient) return;
    
    try {
      await kvsClient.stop();
      
      this.callStatus = 'ended';
      this.isInCall = false;
      this.micImg.style.display = "none";
      this.requestUpdate();
      
      console.log('Call ended');
      
      // Reset status after 2 seconds
      setTimeout(() => {
        this.callStatus = 'idle';
        this.requestUpdate();
      }, 2000);
    } catch (error) {
      console.error('Error ending call:', error);
      this.feedback.labelText = `Error ending call: ${error.message}`;
      this.feedback.show();
    }
  }

  async invokeAudioProcessor(audioData, chunkIndex, isLastChunk) {
    try {
      const response = await fetch(AUDIO_PROCESSOR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioData,
          language: this.nativeLang,
          sessionId: this.sessionId,
          chunkIndex,
          isLastChunk,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('Audio processor response:', result);
      return result;
    } catch (error) {
      console.error('Error invoking audio processor:', error);
      this.feedback.labelText = `Error processing audio: ${error.message}`;
      this.feedback.show();
      throw error;
    }
  }

  async invokeTTSHandler(text, language) {
    try {
      const response = await fetch(TTS_HANDLER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          language,
          sessionId: this.sessionId,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      console.log('TTS handler response:', result);
      return result;
    } catch (error) {
      console.error('Error invoking TTS handler:', error);
      this.feedback.labelText = `Error generating speech: ${error.message}`;
      this.feedback.show();
      throw error;
    }
  }

  handleTranscriptionResult(message) {
    const { chunkIndex, result, isLastChunk } = message;
    
    if (chunkIndex === 0) {
      this.sendTxtElm.innerHTML = this.sendTxt = `You: ${result.transcription}`;
    } else {
      this.sendTxtElm.innerHTML = this.sendTxt += ` ${result.transcription}`;
    }
    
    if (isLastChunk) {
      console.log('All chunks processed, waiting for translation...');
    }
  }

  async handleTranslationResult(message) {
    const { translation, originalText } = message;
    
    try {
      const translations = JSON.parse(translation);
      const translatedText = translations[myTextIdx] || translations[0];
      
      this.receiveTxtElm.innerHTML = `${this.myName} (${this.nativeLang}): ${translatedText}`;
      
      // Trigger TTS for the translated text
      await this.invokeTTSHandler(translatedText, this.nativeLang);
      
    } catch (error) {
      console.error('Error parsing translation:', error);
      this.feedback.labelText = 'Translation parsing error';
      this.feedback.show();
    }
  }

  handleTTSResult(message) {
    const { audioData, text } = message;
    
    // Convert base64 audio to blob and play
    const audioBlob = base64ToBlob(audioData, 'audio/mpeg');
    const audioUrl = URL.createObjectURL(audioBlob);
    
    this.playAudio(audioUrl);
  }


  playAudio(audioUrl) {
    if (is_safari) {
      if (is_chrome) {
        this.audioElm.src = audioUrl;
        this.audioElm.pause();
        this.audioElm.currentTime = 0;
        this.audioElm.load();
      } else {
        this.audioElm.querySelector("source").src = audioUrl;
        this.audioElm.pause();
        this.audioElm.currentTime = 0;
        this.audioElm.load();
      }
    } else {
      this.audioElm.src = audioUrl;
    }
    this.audioElm.play();
  }

  // Old recording methods removed - now using WebRTC real-time audio


  async confirmProfile() {
    if (!this.myNameElm.value || !this.nativeSelect.value) {
      this.feedback.labelText = "Please select the required fields above";
      this.feedback.show();
      return;
    }

    this.myName = this.myNameElm.value;
    this.nativeLang = this.nativeSelect.value;

    this.nativeSelect.style.display = "none";
    this.myNameElm.style.display = "none";
    this.confirmBtn.style.display = "none";
    
    // Show call controls
    this.callControlsElm.style.display = "block";
    
    myTextIdx = ["id-ID", "hi-IN", "fr-FR", "en-US"].findIndex(lidx => lidx === this.nativeLang);
    
    console.log(`Profile confirmed: ${this.myName} (${this.nativeLang})`);
    console.log('Ready to start or join call!');
  }

}

window.customElements.define('comm-ai', CommAi);