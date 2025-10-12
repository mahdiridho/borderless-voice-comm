/**
 * Amazon Kinesis Video Streams WebRTC Client
 * MUCH simpler than custom WebRTC - AWS handles everything!
 */

import { KinesisVideoClient, DescribeSignalingChannelCommand } from '@aws-sdk/client-kinesis-video';
import { KinesisVideoSignalingClient, GetIceServerConfigCommand } from '@aws-sdk/client-kinesis-video-signaling';
import { SignalingClient } from 'amazon-kinesis-video-streams-webrtc';

export class KVSWebRTCClient {
  constructor(config) {
    this.region = config.region;
    this.channelARN = config.channelARN;
    this.channelName = config.channelName;
    this.credentials = config.credentials;
    this.role = config.role || 'VIEWER'; // MASTER or VIEWER
    this.clientId = config.clientId || `client-${Date.now()}`;
    
    // Callbacks
    this.onRemoteStream = config.onRemoteStream || (() => {});
    this.onConnected = config.onConnected || (() => {});
    this.onDisconnected = config.onDisconnected || (() => {});
    this.onError = config.onError || ((error) => console.error('KVS WebRTC Error:', error));
    this.onAudioChunk = config.onAudioChunk || null;
    
    // State
    this.signalingClient = null;
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.isConnected = false;
    this.audioContext = null;
  }

  /**
   * Initialize and start WebRTC connection
   * AWS handles all the complexity!
   */
  async start() {
    try {
      console.log(`Starting KVS WebRTC as ${this.role}...`);
      
      // Step 1: Get microphone access
      await this.initializeLocalStream();
      
      // Step 2: Get KVS signaling channel endpoint
      const endpointsByProtocol = await this.getSignalingChannelEndpoint();
      
      // Step 3: Get ICE server configuration (STUN/TURN from AWS)
      const iceServers = await this.getIceServerConfig(endpointsByProtocol);
      
      // Step 4: Create signaling client
      await this.createSignalingClient(endpointsByProtocol);
      
      // Step 5: Create peer connection
      await this.createPeerConnection(iceServers);
      
      // Step 6: Setup audio processing (optional, for transcription)
      if (this.onAudioChunk) {
        await this.setupAudioProcessing();
      }
      
      console.log('KVS WebRTC started successfully');
      return true;
    } catch (error) {
      console.error('Error starting KVS WebRTC:', error);
      this.onError(error);
      throw error;
    }
  }

  /**
   * Get microphone access
   */
  async initializeLocalStream() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
        video: false,
      });
      
      console.log('Local audio stream initialized');
      return this.localStream;
    } catch (error) {
      console.error('Error getting microphone:', error);
      throw error;
    }
  }

  /**
   * Get KVS signaling channel endpoint from AWS
   */
  async getSignalingChannelEndpoint() {
    try {
      const kinesisVideoClient = new KinesisVideoClient({
        region: this.region,
        credentials: this.credentials,
      });
      
      const describeSignalingChannelCommand = new DescribeSignalingChannelCommand({
        ChannelARN: this.channelARN,
      });
      
      const response = await kinesisVideoClient.send(describeSignalingChannelCommand);
      const channelEndpoint = response.ChannelInfo.ChannelEndpoint;
      
      // Get endpoints by protocol
      const endpointsByProtocol = {
        HTTPS: channelEndpoint || `https://kinesisvideo.${this.region}.amazonaws.com`,
        WSS: channelEndpoint?.replace('https://', 'wss://') || `wss://kinesisvideo.${this.region}.amazonaws.com`,
      };
      
      console.log('Got signaling channel endpoints:', endpointsByProtocol);
      return endpointsByProtocol;
    } catch (error) {
      console.error('Error getting signaling channel endpoint:', error);
      throw error;
    }
  }

  /**
   * Get ICE server configuration (STUN/TURN) from AWS
   * AWS provides this for FREE!
   */
  async getIceServerConfig(endpointsByProtocol) {
    try {
      const kinesisVideoSignalingClient = new KinesisVideoSignalingClient({
        region: this.region,
        credentials: this.credentials,
        endpoint: endpointsByProtocol.HTTPS,
      });
      
      const getIceServerConfigCommand = new GetIceServerConfigCommand({
        ChannelARN: this.channelARN,
      });
      
      const response = await kinesisVideoSignalingClient.send(getIceServerConfigCommand);
      
      const iceServers = response.IceServerList.map(iceServer => ({
        urls: iceServer.Uris,
        username: iceServer.Username,
        credential: iceServer.Password,
      }));
      
      console.log('Got ICE servers from AWS:', iceServers.length);
      return iceServers;
    } catch (error) {
      console.error('Error getting ICE server config:', error);
      throw error;
    }
  }

  /**
   * Create KVS signaling client
   * This handles all WebRTC signaling automatically!
   */
  async createSignalingClient(endpointsByProtocol) {
    try {
      this.signalingClient = new SignalingClient({
        channelARN: this.channelARN,
        channelEndpoint: endpointsByProtocol.WSS,
        role: this.role,
        region: this.region,
        credentials: this.credentials,
        clientId: this.role === 'VIEWER' ? this.clientId : undefined,
        systemClockOffset: 0,
      });
      
      // Open signaling connection
      await this.signalingClient.open();
      
      console.log('Signaling client connected');
    } catch (error) {
      console.error('Error creating signaling client:', error);
      throw error;
    }
  }

  /**
   * Create WebRTC peer connection
   * AWS SDK makes this simple!
   */
  async createPeerConnection(iceServers) {
    try {
      this.peerConnection = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: 'all',
      });
      
      // Add local stream to peer connection
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
      
      // Handle remote stream
      this.peerConnection.ontrack = (event) => {
        console.log('Received remote stream');
        this.remoteStream = event.streams[0];
        this.onRemoteStream(this.remoteStream);
      };
      
      // Handle connection state
      this.peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', this.peerConnection.connectionState);
        
        if (this.peerConnection.connectionState === 'connected') {
          this.isConnected = true;
          this.onConnected();
        } else if (this.peerConnection.connectionState === 'disconnected' || 
                   this.peerConnection.connectionState === 'failed') {
          this.isConnected = false;
          this.onDisconnected();
        }
      };
      
      // Setup signaling handlers
      this.setupSignalingHandlers();
      
      // If MASTER, create and send offer
      if (this.role === 'MASTER') {
        await this.createAndSendOffer();
      }
      
      console.log('Peer connection created');
    } catch (error) {
      console.error('Error creating peer connection:', error);
      throw error;
    }
  }

  /**
   * Setup signaling message handlers
   */
  setupSignalingHandlers() {
    // Handle incoming SDP offer (for VIEWER)
    this.signalingClient.on('sdpOffer', async (offer, remoteClientId) => {
      console.log('Received SDP offer');
      
      try {
        await this.peerConnection.setRemoteDescription(offer);
        
        // Create and send answer
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        
        this.signalingClient.sendSdpAnswer(answer, remoteClientId);
        console.log('Sent SDP answer');
      } catch (error) {
        console.error('Error handling SDP offer:', error);
      }
    });
    
    // Handle incoming SDP answer (for MASTER)
    this.signalingClient.on('sdpAnswer', async (answer) => {
      console.log('Received SDP answer');
      
      try {
        await this.peerConnection.setRemoteDescription(answer);
      } catch (error) {
        console.error('Error handling SDP answer:', error);
      }
    });
    
    // Handle ICE candidates
    this.signalingClient.on('iceCandidate', async (candidate) => {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    });
    
    // Send ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendIceCandidate(event.candidate);
      }
    };
    
    // Handle signaling errors
    this.signalingClient.on('error', (error) => {
      console.error('Signaling error:', error);
      this.onError(error);
    });
  }

  /**
   * Create and send SDP offer (MASTER only)
   */
  async createAndSendOffer() {
    try {
      const offer = await this.peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      
      await this.peerConnection.setLocalDescription(offer);
      
      this.signalingClient.sendSdpOffer(offer);
      console.log('Sent SDP offer');
    } catch (error) {
      console.error('Error creating offer:', error);
      throw error;
    }
  }

  /**
   * Setup audio processing for transcription
   */
  async setupAudioProcessing() {
    if (!this.localStream || !this.onAudioChunk) return;
    
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000, // Optimal for Whisper
      });
      
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      const processor = this.audioContext.createScriptProcessor(2048, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (!this.isConnected) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Convert to Int16Array for compression
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Send to transcription
        this.onAudioChunk(pcmData.buffer);
      };
      
      source.connect(processor);
      processor.connect(this.audioContext.destination);
      
      console.log('Audio processing pipeline initialized');
    } catch (error) {
      console.error('Error setting up audio processing:', error);
    }
  }

  /**
   * Stop and cleanup
   */
  async stop() {
    console.log('Stopping KVS WebRTC...');
    
    try {
      // Close peer connection
      if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
      }
      
      // Close signaling client
      if (this.signalingClient) {
        this.signalingClient.close();
        this.signalingClient = null;
      }
      
      // Stop local stream
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => track.stop());
        this.localStream = null;
      }
      
      // Close audio context
      if (this.audioContext) {
        await this.audioContext.close();
        this.audioContext = null;
      }
      
      this.isConnected = false;
      console.log('KVS WebRTC stopped');
    } catch (error) {
      console.error('Error stopping KVS WebRTC:', error);
    }
  }

  /**
   * Get connection statistics
   */
  async getStats() {
    if (!this.peerConnection) return null;
    
    try {
      const stats = await this.peerConnection.getStats();
      const result = { audio: {}, connection: {} };
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          result.audio.inbound = {
            packetsReceived: report.packetsReceived,
            packetsLost: report.packetsLost,
            jitter: report.jitter,
            bytesReceived: report.bytesReceived,
          };
        } else if (report.type === 'outbound-rtp' && report.kind === 'audio') {
          result.audio.outbound = {
            packetsSent: report.packetsSent,
            bytesSent: report.bytesSent,
          };
        } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          result.connection = {
            currentRoundTripTime: report.currentRoundTripTime,
            availableOutgoingBitrate: report.availableOutgoingBitrate,
          };
        }
      });
      
      return result;
    } catch (error) {
      console.error('Error getting stats:', error);
      return null;
    }
  }
}

