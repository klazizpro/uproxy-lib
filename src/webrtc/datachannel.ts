/// <reference path='../handler/queue.d.ts' />
/// <reference path='../arraybuffers/arraybuffers.d.ts' />
/// <reference path="../third_party/typings/es6-promise/es6-promise.d.ts" />
/// <reference path='../freedom/typings/rtcdatachannel.d.ts' />

// DataPeer - a class that wraps peer connections and data channels.
//
// This class assumes WebRTC is available; this is provided by the cross-
// platform compatibility library webrtc-adaptor.js (from:
// https://code.google.com/p/webrtc/source/browse/stable/samples/js/base/adapter.js)

module WebRtc {

  // Messages are limited to a 16KB length by SCTP; we use 15k for safety.
  // TODO: test if we can up this to 16k; test the edge-cases!
  // http://tools.ietf.org/html/draft-ietf-rtcweb-data-channel-07#section-6.6
  var CHUNK_SIZE = 1024 * 15;
  // The maximum amount of bytes we should allow to get queued up in
  // peerconnection. Any more and we start queueing in JS. Data channels are
  // closed by WebRTC when the buffer fills, so we really don't want that happen
  // accidentally. More info in this thread (note that 250Kb is well below both
  // the 16MB for Chrome 37+ and "100 messages" of previous versions mentioned):
  //   https://code.google.com/p/webrtc/issues/detail?id=2866
  // CONSIDER: make it 0. There is no size in the spec.
  var PC_QUEUE_LIMIT = 1024 * 250;
  // Javascript has trouble representing integers larger than 2^53. So we simply
  // don't support trying to send array's bigger than that.
  var MAX_MESSAGE_SIZE = Math.pow(2, 53);

  // Data sent to or received from a peer on a data channel in the peer
  // connection.
  export interface Data {
    str ?:string;
    buffer ?:ArrayBuffer;
    // TODO: add when supported by WebRtc in Chrome and FF.
    // https://code.google.com/p/webrtc/issues/detail?id=2276
    //
    // bufferView  ?:ArrayBufferView;
    // blob        ?:Blob
    // domString   ?:DOMString
  }
  interface StringData {
    str :string;
  }
  interface BufferData {
    buffer :ArrayBuffer;
  }

  var log :Logging.Log = new Logging.Log('DataChannel');

  // Wrapper for a WebRtc Data Channels:
  // http://dev.w3.org/2011/webrtc/editor/webrtc.html#rtcdatachannel
  //
  //
  export class DataChannel {

    public dataFromPeerQueue      :Handler.Queue<Data,void>;

    // The |toPeerDataQueue_| is chunked by the send call and conjection
    // controlled by the handler this class sets.
    private toPeerDataQueue_        :Handler.Queue<Data,void>;

    public onceOpened      :Promise<void>;
    public onceClosed      :Promise<void>;

    private opennedSuccessfully_ :boolean;
    private rejectOpened_  :(e:Error) => void;

    private label_ :string;
    public getLabel = () : string => {
      return this.label_;
    }

    private rtcDataChannel_:freedom_RTCDataChannel.RTCDataChannel;

    // PRIVATE CONSTRUCTOR.  Typescript does not support marking a
    // constructor as private, but this constructor should only be
    // used by the |fromId| static factory method, because the
    // |label_| field has not yet been populated.
    // |id| is the Freedom GUID for the underlying browser object.
    constructor(id:string) {
      this.rtcDataChannel_ = freedom['core.rtcdatachannel'](id);
      this.dataFromPeerQueue = new Handler.Queue<Data,void>();
      this.toPeerDataQueue_ = new Handler.Queue<Data,void>();
      this.onceOpened = new Promise<void>((F,R) => {
        this.rejectOpened_ = R;
        this.rtcDataChannel_.getReadyState().then((state:string) => {
          // RTCDataChannels created by a RTCDataChannelEvent have an initial
          // state of open, so the onopen event for the channel will not
          // fire. We need to fire the onOpenDataChannel event here
          // http://www.w3.org/TR/webrtc/#idl-def-RTCDataChannelState
          if (state === 'open') {
            F();
          } else if (state === 'connecting') {
            // Firefox channels do not have an initial state of 'open'
            // See https://bugzilla.mozilla.org/show_bug.cgi?id=1000478
            this.rtcDataChannel_.on('onopen', F);
          }
        });
      });
      this.onceClosed = new Promise<void>((F,R) => {
          this.rtcDataChannel_.on('onclose', F);
        });
      this.rtcDataChannel_.on('onmessage', this.onDataFromPeer_);
      this.rtcDataChannel_.on('onerror', (e:Event) => {
        log.error('rtcDataChannel_.onerror: ' + e.toString);
      });
      this.onceOpened.then(() => {
        this.opennedSuccessfully_ = true;
        this.toPeerDataQueue_.setHandler(this.handleSendDataToPeer_);
      });
      this.onceClosed.then(() => {
          if(!this.opennedSuccessfully_) {
            // Make sure to reject the onceOpened promise if state went from
            // |connecting| to |close|.
            this.rejectOpened_(new Error(
                'Failed to open; closed while trying to open.'));
          }
          this.opennedSuccessfully_ = false;
        });
    }

    // Factory method.  This method should be used instead of the constructor.
    // After this method returns, the channel's label property is available
    // synchronously.
    // |id| is the Freedom GUID for the underlying browser object.
    public static fromId = (id:string) : Promise<DataChannel> => {
      var channel :DataChannel = new DataChannel(id);
      return channel.rtcDataChannel_.getLabel().then((label:string) => {
        channel.label_ = label;
        return channel;
      });
    }

    // Handle data we get from the peer by putting it, appropriately wrapped, on
    // the queue of data from the peer.
    private onDataFromPeer_ = (message:freedom_RTCDataChannel.Message) : void => {
      if (typeof message.text === 'string') {
        this.dataFromPeerQueue.handle({str: message.text});
      } else if (message.buffer instanceof ArrayBuffer) {
        this.dataFromPeerQueue.handle({buffer: message.buffer});
      } else {
        log.error('Unexpected data from peer: ' + JSON.stringify(message));
      }
    }

    // Promise completes once all the data has been sent. This is async because
    // there may be more data than fits in the buffer; we do chunking so that
    // data larger than the SCTP message size limit (about 16k) can be sent and
    // received reliably, and so that the internal buffer is not over-filled. If
    // data is too big we also fail.
    //
    // CONSIDER: We could support blob data by streaming into array-buffers.
    public send = (data:Data) : Promise<void> => {
      // Note: you cannot just write |if(data.str) ...| because str may be empty
      // which is treated as false. You have to do something more verbose, like
      // |if (typeof data.str === 'string') ...|.
      if (!(typeof data.str === 'string' ||
           (typeof data.buffer === 'object') &&
             (data.buffer instanceof ArrayBuffer)) ) {
        return Promise.reject(
            new Error('data to send must have at least `str:string` or ' +
                '`buffer:ArrayBuffer` defined (typeof data.str === ' +
                typeof data.str + '; typeof data.buffer === ' +
                typeof data.buffer +
                '; data.buffer instanceof ArrayBuffer === ' +
                (data.buffer instanceof ArrayBuffer) + ')'));
      }

      var byteLength :number;
      if (typeof data.str === 'string') {
        // JS strings are utf-16.
        byteLength = data.str.length * 2;
      } else if (data.buffer) {
        byteLength = data.buffer.byteLength;
      }

      if(byteLength > MAX_MESSAGE_SIZE) {
        return Promise.reject(new Error(
            'Data was too big to send, sorry. ' +
            'Need to wait for real Blob support.'));
      }

      if(typeof data.str === 'string') {
        return this.chunkStringOntoQueue_({str:data.str});
      } else if(data.buffer) {
        return this.chunkBufferOntoQueue_({buffer:data.buffer});
      }
    }

    // TODO: add an issue for chunking strings, write issue number here, then
    // write the code and resolve the issue :-)
    private chunkStringOntoQueue_ = (data:StringData) : Promise<void> => {
      return this.toPeerDataQueue_.handle(data);
    }

    private chunkBufferOntoQueue_ = (data:BufferData) : Promise<void> => {
      var chunks = ArrayBuffers.chunk(data.buffer, CHUNK_SIZE);
      var promises :Promise<void>[] = [];
      chunks.forEach((chunk) => {
        promises.push(this.toPeerDataQueue_.handle({buffer: chunk}));
      });
      // CONSIDER: can we change the interface to support not having the dummy
      // extra return at the end?
      return Promise.all(promises).then(() => { return; });
    }

    // Assumes data is chunked.
    private handleSendDataToPeer_ = (data:Data) : Promise<void> => {
      try {
        if(typeof data.str === 'string') {
          this.rtcDataChannel_.send(data.str);
        } else if(data.buffer) {
          this.rtcDataChannel_.sendBuffer(data.buffer);
        } else {
          // Data is good when it meets the type expected of the Data. If type-
          // saftey is ensured at compile time, this should never happen.
          return Promise.reject(new Error(
              'Bad data: ' + JSON.stringify(data)));
        }
      // Can raise NetworkError if channel died, for example.
      } catch (e) {
        log.debug('Error in send' + e.toString());
        return Promise.reject(new Error(
            'Error in send: ' + JSON.stringify(e)));
      }
      this.conjestionControlSendHandler();
      return Promise.resolve<void>();
    }

    // TODO: make this timeout adaptive so that we keep the buffer as full as we
    // can without wasting timeout callbacks. When DataChannels correctly has a
    // callback for buffering, we don't need to do this anymore.
    private conjestionControlSendHandler = () : void => {
      this.rtcDataChannel_.getBufferedAmount().then((bufferedAmount:number) => {
        if(bufferedAmount + CHUNK_SIZE > PC_QUEUE_LIMIT) {
          if(this.toPeerDataQueue_.isHandling()) {
            this.toPeerDataQueue_.stopHandling();
          }
          setTimeout(this.conjestionControlSendHandler, 20);
        } else {
          if(!this.toPeerDataQueue_.isHandling()) {
            this.toPeerDataQueue_.setHandler(this.handleSendDataToPeer_);
          }
        }
      });
    }

    public close = () : void => {
      this.rtcDataChannel_.close();
    }

    public toString = () : string => {
      var s = this.getLabel() + ': opennedSuccessfully_=' +
        this.opennedSuccessfully_;
      return s;
    }
  }  // class DataChannel
}  // module
