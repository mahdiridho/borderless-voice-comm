"use strict";

/** handle messages are breathe up to methods
Messages will be in the following format :
{method, data}
*/
class MessageHandler {
  constructor(){
    console.log('MessageHandler::constructor')
  }

  /** When we receive a message extract the UUID, method and data
  @param e The event with the data
  */
  onmessage(e){
    // console.log('MessageHandler:onmessage')
    // call the method and respond with its returning value
    this[e.data.method](e.data.data);
  }

  /** No operation
  */
  noop(data){

  }
}

export class RecorderPCM extends MessageHandler {

  getInputDeviceCount(){
    let inputDeviceCnt = 0;
    navigator.mediaDevices.enumerateDevices()
    .then(function (devices) {
      devices.forEach((device) => {
        // console.log(device);
        if (device.kind == 'audioinput')
          inputDeviceCnt++;
        // console.log(device.kind + ": " + device.label +" id = " + device.deviceId);
      });
      if (inputDeviceCnt == 0)
        console.error('AudioRecorder::init : no input media devices present.');
      else
        console.log('Found '+inputDeviceCnt+' input devices')
      return inputDeviceCnt;
    })
    .catch(function (err) {
      console.log(err.name + ": " + err.message);
      return -1;
    });
  }

  /** For PCM audio recording turn off all pre-processing and video.
  */
  setMediaConstraints(){
    // Produce media stream from audio input
    let constraints = { audio: {}, video: false };
    let supportedConstraints = navigator.mediaDevices.getSupportedConstraints();
    if (supportedConstraints.echoCancellation)
      constraints.audio.echoCancellation = false;
    else
      console.log('warning : mediaDevices has no echoCancellation constraint');
    if (supportedConstraints.noiseSuppression)
      constraints.audio.noiseSuppression = false;
    else
      console.log('warning : mediaDevices has no noiseSuppression constraint');
    if (supportedConstraints.autoGainControl)
      constraints.audio.autoGainControl = false;
    else
      console.log('warning : mediaDevices has no autoGainControl constraint');
    if (Object.keys(constraints.audio).length === 0)
      constraints.audio = true;
    return constraints;
  }

  /** Initialise the worklet
  */
  init() {
    if (this.getInputDeviceCount()<1) // make sure there are input devices
      throw new Error('No input audio devices');
    let constraints = this.setMediaConstraints();
    return navigator.mediaDevices.getUserMedia(constraints).then(stream => {
      // console.log(stream)
      // let tracks = stream.getAudioTracks();
      // let settings = tracks[0].getSettings();
      // let constraints = tracks[0].getConstraints();
      // console.log(tracks)
      // console.log(settings)
      // console.log(constraints)
      // console.log(settings.sampleRate)
      // console.log(this.context.sampleRate)

      if (!this.context)
        this.context = new (window.AudioContext || window.webkitAudioContext)({sampleRate : 48000}); // TODO : sampleRate should not be hard coded. We should have a global DefaultParameters class which specifies some standard parameters
      try {
        this.audioInput = this.context.createMediaStreamSource(stream);
      } catch (e){ // firefox doesn't resample ....
        this.context = new (window.AudioContext || window.webkitAudioContext)({sampleRate : 44100}); // TODO : sampleRate should not be hard coded. We should have a global DefaultParameters class which specifies some standard parameters
        this.audioInput = this.context.createMediaStreamSource(stream);
      }
      return this.context.audioWorklet.addModule('recorder-worklet.js').then(() => {
        this.createWorklet(stream);
      }).catch(async e => {
        if (e.code == 20 || e.code == 19) { // can't find recorder-worklet in the root app
          this.context.audioWorklet.addModule('node_modules/@flatmax/audio-recorder/recorder-worklet.js')
          .then(() => {
            this.createWorklet(stream);
          })
          .catch(e => {console.log('couldn\'t create the worklet'); throw e});
        }
      })
    });
  }

  createWorklet(stream) {
    // TODO : numbe of channels shouldn't be hard coded here either.
    this.audioWorkletNode = new AudioWorkletNode(this.context, 'recorder-worklet', { 'numberOfInputs': 2, 'numberOfOutputs': 2 });
    this.audioWorkletNode.port.onmessage = this.onmessage.bind(this);
    this.audioInput = this.context.createMediaStreamSource(stream);
    this.audioInput.connect(this.audioWorkletNode).connect(this.context.destination);
    console.log('worklet created')
  }

  postMessage(msg){
    if (this.audioWorkletNode)
      this.audioWorkletNode.port.postMessage(msg);
    else
      console.log('AudioWorklet doesn\'t exist, please create it first.');
  }

  // /** Get the audio worklet port for messaging
  // */
  // get port(){
  //   if (this.audioWorkletNode)
  //     this.audioWorkeltNode.port;
  //   else
  //     throw new Error('RecorderPCM::port : AudioWorkletNode has not been instantiated, can\'t get its port');
  // }

  start(){
    console.log('RecorderPCM start')
    this.postMessage({method:'start', data:0});
  }

  started(){
    console.log('RecorderWorklet has started');
    window.dispatchEvent(new CustomEvent('user-feedback', {
      detail: {
        message: "Capturing",
        timeout: -1 // disable the timeout
      }
    }));
  }

  stop(){
    window.dispatchEvent(new CustomEvent('user-feedback', {
      detail: {
        message: "Plotting the audio"
      }
    }));
    console.log('RecorderPCM stop')
    this.postMessage({method:'stop', data:0});
  }

  /** Once the worklet has stopped, get the audio data
  */
  stopped(){
    console.log('RecorderWorklet has stopped, getting audio data');
    this.postMessage({method:'getData', data:0});
  }

  /** Tell the recorder which method to execute when data is received
  */
  giveDataMethod(mth){
    this.giveData = mth;
  }

  /** Receive the audio data from the worklet and execute the receiver
  @param data the audio data
  */
  receiveData(data){
    if (this.giveData)
      this.giveData(data);
  }

  /** Get the sample rate
  @returns The same rate
  */
  getFS(){
    if (this.context)
      return this.context.sampleRate;
    throw new Error('RecorderPCM::getFS : no audio context to get FS from');
  }
}
