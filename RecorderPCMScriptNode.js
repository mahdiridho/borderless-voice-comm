"use strict";

class Recorder  {
  constructor(){
    this.data = [];
    this.recording=0;
  }

  /** Store input data
  @param inputs An array of inputs connected to the node [[Float32Array ...] ...]
  @param outputs An array of outputs connected to the node [[Float32Array ...] ...]
  @return true to continue processing
  */
  process(e) {
    if (this.recording){
      // console.log(e)
      let input = e.inputBuffer;
        // console.log('Recorder  : process recording time = '+e.playbackTime)
        // console.log(input);
      // deep copy the data
      let ar = new Array(input.numberOfChannels);
      for (let c = 0; c<ar.length; c++)
        ar[c] = Float32Array.from(input.getChannelData(c));
      this.data.push(ar);
    }
    return true;
  }

  /** Clear the data and start recording
  */
  start(){
    this.data = [];
    this.recording = 1;
  }

  /** Indicate that we aren't recording any more
  */
  stop(){
    if (this.recording)
      this.recording = 0;
    else
      console.log('Recorder ::stop : already stopped, not executing a second time.');
  }

  /** We will concatenate all audio data and return with the method to call
  */
  getData(){
      let len = 0;
      this.data.forEach(d => len+=d[0].length);
      console.log('total length = '+len)
      console.log('total time = '+len/this.getFS())
      if (len){
        let retDat = new Array(this.data[0].length);
        for (let c = 0; c<retDat.length; c++)
          retDat[c]= new Float32Array(len);
        let n=0;
        for (let m = 0; m<this.data.length; m++){ // for each data block
          for (let c = 0; c<this.data[m].length; c++) // for each audio vector
            retDat[c].set(this.data[m][c], n);
          n+=this.data[m][0].length;
        }
        this.data=[]; // clear the data
        return retDat;
      } else
        return []; // return no operation
  }
}

export class RecorderPCMSPN extends Recorder  {
  constructor(){
    super();
    this.T=100e-3; // block size in s
  }

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
      if (!this.context)
        this.context = new (window.AudioContext || window.webkitAudioContext)({sampleRate : 48000}); // TODO : sampleRate should not be hard coded. We should have a global DefaultParameters class which specifies some standard parameters
      try {
        this.audioInput = this.context.createMediaStreamSource(stream);
      } catch (e){ // firefox doesn't resample ....
        this.context = new (window.AudioContext || window.webkitAudioContext)({sampleRate : 44100}); // TODO : sampleRate should not be hard coded. We should have a global DefaultParameters class which specifies some standard parameters
        this.audioInput = this.context.createMediaStreamSource(stream);
      }
      this.audioInput = this.context.createMediaStreamSource(stream);
      let latency = Math.pow(2, Math.round(Math.log2(this.T*this.context.sampleRate)));
      console.log('latency = '+latency+' samples');
      this.scriptNode = this.context.createScriptProcessor(Math.round(latency, 2, 0)); // TODO : This should not be hard coded to 2 channel input
      this.scriptNode.onaudioprocess = this.process.bind(this);
      this.audioInput.connect(this.scriptNode).connect(this.context.destination);
      return 0;
    });
  }

  postMessage(msg){
    if (this.audioWorkletNode)
      this.audioWorkletNode.port.postMessage(msg);
    else
      console.log('AudioWorklet doesn\'t exist, please create it first.');
  }

  start(){
    console.log('RecorderPCMScriptNode start')
    super.start();
    console.log('Recorder  has started');
    window.dispatchEvent(new CustomEvent('user-feedback', {
      detail: {
        message: "Capturing",
        timeout: -1 // disable the timeout
      }
    }));
  }

  stop(){
    console.log('RecorderPCMScriptNode stop')
    super.stop();
    console.log('Recorder  has stopped, getting audio data');
    let d = this.getData();
    if (d.length)
      this.giveData(d);
    else
      console.log('RecorderPCM::stop : no data to give.');
  }

  /** Tell the recorder which method to execute when data is received
  */
  giveDataMethod(mth){
    this.giveData = mth;
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
