/**
 * AppSync Events API Client
 * Handles WebSocket connection and pub/sub for AppSync Events
 */

export class AppSyncEventsClient {
  constructor(config) {
    this.apiId = config.apiId;
    this.region = config.region;
    this.apiKey = config.apiKey;
    this.channels = config.channels || [];
    this.sessionId = config.sessionId;
    
    this.ws = null;
    this.connected = false;
    this.subscriptions = new Map();
    this.messageHandlers = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
  }

  /**
   * Connect to AppSync Events WebSocket endpoint
   */
  async connect() {
    const wsUrl = this._buildWebSocketUrl();
    
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
          console.log('AppSync Events WebSocket connected');
          this.connected = true;
          this.reconnectAttempts = 0;
          
          // Subscribe to all configured channels
          this._subscribeToChannels();
          
          resolve();
        };
        
        this.ws.onmessage = (event) => {
          this._handleMessage(event.data);
        };
        
        this.ws.onerror = (error) => {
          console.error('AppSync Events WebSocket error:', error);
          this.connected = false;
          reject(error);
        };
        
        this.ws.onclose = () => {
          console.log('AppSync Events WebSocket closed');
          this.connected = false;
          this._attemptReconnect();
        };
        
      } catch (error) {
        console.error('Error connecting to AppSync Events:', error);
        reject(error);
      }
    });
  }

  /**
   * Build WebSocket URL with authentication
   */
  _buildWebSocketUrl() {
    const realtimeEndpoint = `wss://${this.apiId}.appsync-realtime-api.${this.region}.amazonaws.com/event/realtime`;
    
    // Create connection header with API key authentication
    const header = {
      host: `${this.apiId}.appsync-api.${this.region}.amazonaws.com`,
      'x-api-key': this.apiKey,
    };
    
    const headerBase64 = btoa(JSON.stringify(header));
    const payloadBase64 = btoa(JSON.stringify({}));
    
    return `${realtimeEndpoint}?header=${headerBase64}&payload=${payloadBase64}`;
  }

  /**
   * Subscribe to configured channels
   */
  _subscribeToChannels() {
    this.channels.forEach(channel => {
      this.subscribe(channel);
    });
  }

  /**
   * Subscribe to a channel
   */
  subscribe(channel, namespace = null) {
    if (!this.connected) {
      console.warn('Not connected, cannot subscribe to channel:', channel);
      return;
    }

    const channelName = namespace ? `${channel}/${namespace}` : `${channel}/${this.sessionId}`;
    
    const subscriptionMessage = {
      type: 'subscribe',
      channel: channelName,
    };
    
    this.ws.send(JSON.stringify(subscriptionMessage));
    this.subscriptions.set(channelName, true);
    
    console.log(`Subscribed to channel: ${channelName}`);
  }

  /**
   * Unsubscribe from a channel
   */
  unsubscribe(channel, namespace = null) {
    if (!this.connected) {
      return;
    }

    const channelName = namespace ? `${channel}/${namespace}` : `${channel}/${this.sessionId}`;
    
    const unsubscribeMessage = {
      type: 'unsubscribe',
      channel: channelName,
    };
    
    this.ws.send(JSON.stringify(unsubscribeMessage));
    this.subscriptions.delete(channelName);
    
    console.log(`Unsubscribed from channel: ${channelName}`);
  }

  /**
   * Register a message handler for a specific channel
   */
  on(channel, handler) {
    this.messageHandlers.set(channel, handler);
  }

  /**
   * Handle incoming WebSocket messages
   */
  _handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      switch (message.type) {
        case 'connection_ack':
          console.log('Connection acknowledged');
          break;
          
        case 'ka': // Keep-alive
          // Respond with keep-alive
          if (this.ws && this.connected) {
            this.ws.send(JSON.stringify({ type: 'ka' }));
          }
          break;
          
        case 'subscribe_success':
          console.log('Subscription successful:', message.channel);
          break;
          
        case 'subscribe_error':
          console.error('Subscription error:', message);
          break;
          
        case 'event':
          this._handleEvent(message);
          break;
          
        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  /**
   * Handle event messages
   */
  _handleEvent(message) {
    try {
      const { channel, events } = message;
      
      if (!events || events.length === 0) {
        return;
      }

      // Parse each event
      events.forEach(eventData => {
        try {
          const event = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;
          
          // Find matching handler
          for (const [handlerChannel, handler] of this.messageHandlers) {
            if (channel.startsWith(handlerChannel)) {
              handler(event);
              break;
            }
          }
        } catch (error) {
          console.error('Error parsing event:', error);
        }
      });
    } catch (error) {
      console.error('Error handling event:', error);
    }
  }

  /**
   * Attempt to reconnect
   */
  _attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connect().catch(error => {
        console.error('Reconnection failed:', error);
      });
    }, this.reconnectDelay);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    if (this.ws) {
      this.connected = false;
      this.ws.close();
      this.ws = null;
      this.subscriptions.clear();
    }
  }

  /**
   * Publish an event to a channel
   */
  async publishEvent(channel, namespace, data) {
    const channelName = namespace ? `${channel}/${namespace}` : `${channel}/${this.sessionId}`;
    
    try {
      // For publishing, we use HTTP endpoint instead of WebSocket
      const endpoint = `https://${this.apiId}.appsync-api.${this.region}.amazonaws.com/event`;
      
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          channel: channelName,
          events: [JSON.stringify(data)],
        }),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      console.log(`Published event to channel: ${channelName}`);
      return await response.json();
    } catch (error) {
      console.error('Error publishing event:', error);
      throw error;
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

