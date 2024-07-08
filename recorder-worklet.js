"use strict";

/** handle messages are breathe up to methods
Messages will be in the following format :
{method, data}
*/
class MessageHandler extends AudioWorkletProcessor {
  constructor(){
    super();
    console.log('MessageHandler::constructor')
    this.port.onmessage = this.onmessage.bind(this);
  }

  /** When we receive a message extract the UUID, method and data
  @param e The event with the data
  */
  onmessage(e){
    // console.log('MessageHandler:onmessage')
    // call the method and respond with its returning value
    this.port.postMessage(this[e.data.method](e.data.data));
  }
}

class RecorderWorklet extends MessageHandler {
  constructor(){
    super();
    this.data = [];
    this.recording=0;
  }

  /** Store input data
  @param inputs An array of inputs connected to the node [[Float32Array ...] ...]
  @param outputs An array of outputs connected to the node [[Float32Array ...] ...]
  @param parameters see doc. on AudioWorkletProcessor::process
  @return true to continue processing
  */
  process(inputs, outputs, parameters) {
    if (this.recording){
      if ((currentFrame%10000)==0)
        console.log('RecorderWorklet : process recording = '+this.recording+' '+currentFrame+' '+currentTime)
      // deep copy the data
      let ar = new Array(inputs[0].length);
      for (let c = 0; c<ar.length; c++)
        ar[c] = Float32Array.from(inputs[0][c]);
      this.data.push(ar);
    }
    return true;
  }

  /** Clear the data and start recording
  */
  start(){
    this.data = [];
    this.recording = 1;
    return {method:'started', data:0};
  }

  /** Indicate that we aren't recording any more
  */
  stop(){
    if (this.recording){
      this.recording = 0;
      return {method:'stopped', data:0};
    }
    console.log('RecorderWorklet::stop : already stopped, not executing a second time.');
    return {method:'noop', data:0}; // return no operation
  }

  /** We will concatenate all audio data and return with the method to call
  */
  getData(){
      let len = 0;
      this.data.forEach(d => len+=d[0].length);
      console.log('total length = '+len)
      console.log('total time = '+len/sampleRate)
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
        return {method:'receiveData', data:retDat};
      } else
        return {method:'noop', data:0}; // return no operation
  }
}

registerProcessor('recorder-worklet', RecorderWorklet);
