"use client"
import { usePathname } from 'next/navigation';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import io from 'socket.io-client';
import mediasoupClient from 'mediasoup-client'
// import { RemoteVideoPlayer } from '@/app/components/RemoteVideoPlayer';

const VideoConference = () => {
  const [audio, setAudio] = useState(true);
  const [video, setVideo] = useState(true);
  const [stream, setStream] = useState(null);
  const socktRef = useRef(null); // ✅ useRef instead of useState for socket
  const newLocalStream = useRef(null);
  const localVideoRef = useRef(null);
  const [producerTransport, setProducerTransport] = useState();
  // const [device,setDevice]=useState(null);
  const device = useRef(null);
  const [producer, setProducer] = useState(null);
  const [params, setParams] = useState({
    encodings: [
      {
        rid: "r0",
        maxBitrate: 100000,
        scalabilityMode: "S1T3",
      },
      {
        rid: "r1",
        maxBitrate: 300000,
        scalabilityMode: "S1T3",
      },
      {
        rid: "r2",
        maxBitrate: 900000,
        scalabilityMode: "S1T3",
      },
    ],
    codecOptions: {
      videoGoogleStartBitrate: 1000,
    },
  });
  const remoteStreamsRef = useRef([]);
  const [remoteStreams, setRemoteStreams] = useState([]);
  // const remoteStreamsMap = useRef(new Map()); // { id: MediaStream }
  // const [remoteStreams, setRemoteStreams] = useState([]);
  // const remoteVideoRef = useRef(null);
  const [rtpCapabilities, setRtpCapabilities] = useState();
  const [consumerTransports, setConsumerTransports] = useState([]);
  // const [cameras, setCameras] = useState([]);
  // const [selectedCameraId, setSelectedCameraId] = useState(undefined);

  const pathName = usePathname();

  const roomName = pathName.split("/").pop();
  // console.log(pathName, roomName);
  const handleConnSuccess = useCallback(({ socketId }) => {
    console.log("1 ✅ Socket connected to frontend:", socketId);
    getLocalStream();
  }, []);
  const connectSendTransport = useCallback(async (newTransport) => {
    console.log('Connecting send transport...');
    const tempStream = newLocalStream.current;
    console.log('Media stream:', tempStream);
    if (!newTransport || !tempStream) {
      console.error("❌ Producer transport or media stream not available");
      return;
    }
    console.log("📡 Starting Media Production...");
    const track = tempStream.getVideoTracks()[0];
    if (!track) {
      console.error("❌ No video track available");
      return;
    }
    try {
      let tempProducer = await newTransport.produce({ track });
      tempProducer.on("trackended", () => {
        console.warn("⚠️ Track ended.");
      });
      tempProducer.on("transportclose", () => {
        console.warn("⚠️ Transport closed.");
        tempProducer.close();
      });
      console.log("✅ Media production started.");
      console.log('device value in connect send trprt ', device.current);
      setProducer(tempProducer);
    } catch (error) {
      console.error("❌ Error starting media production:", error);
    }
  }, [producerTransport, stream]);
  const getProducers = () => {
    console.log('entered get producers function')
    socktRef.current.emit('getProducers', producerIds => {
      console.log(producerIds)
      // for each of the producer create a consumer
      // producerIds.forEach(id => signalNewConsumerTransport(id))
      producerIds.forEach(signalNewConsumerTransport)
    })
  }
  const addRemoteStream = (id, stream) => {
    remoteStreamsMap.current.set(id, stream);
    setRemoteStreams(Array.from(remoteStreamsMap.current.entries())); // [[id, stream], ...]
  };

  const connectRecvTransport = async (consumerTransportt, remoteProducerId, serverConsumerTransportId) => {
    console.log('connectRecvTransport');
    await socktRef.current.emit('consume', {
      rtpCapabilities: device.current.rtpCapabilities,
      remoteProducerId,
      serverConsumerTransportId,
    }, async ({ params }) => {
      if (params.error) {
        console.log('Cannot Consume');
        return;
      }

      const consumer = await consumerTransportt.consume({
        id: params.id,
        producerId: params.producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters
      });

      setConsumerTransports(prev => [
        ...prev,
        {
          consumerTransportt,
          serverConsumerTransportId: params.id,
          producerId: remoteProducerId,
          consumer,
        }
      ]);

      const { track } = consumer;
      const mediaStream = new MediaStream([track]);
      console.log('new mediatream to be added is ', mediaStream);
      // ✅ Add to remoteStreamsRef if it's a video stream
      if (params.kind === 'video') {
        // Push to the ref
        // console.log('Track enabled:', track.enabled, 'Muted:', track.muted);
        remoteStreamsRef.current.push({ id: remoteProducerId, stream: mediaStream });
        console.log('remoteStreamsRef.current', remoteStreamsRef.current);
        // // Update state to trigger re-render
        setRemoteStreams([...remoteStreamsRef.current]);
        // console.log('remote streams are ', remoteStreams);
        // addRemoteStream(remoteProducerId,mediaStream);
        // remoteVideoRef.current.srcObject=mediaStream;
      }

      // Resume stream from server side
      socktRef.current.emit('consumer-resume', {
        serverConsumerId: params.serverConsumerId
      });
    });
  };
  console.log('remote streams are ', remoteStreams);
  const signalNewConsumerTransport = async (remoteProducerId) => {
    console.log('signalNewConsumerTransport');
    if (consumerTransports.includes(remoteProducerId)) {
      console.log('user is already joined in signalnew consumer transport ');
      return;
    }
    console.log('device value in create recv trprt ', device.current);
    setConsumerTransports(prev => [...prev, remoteProducerId]);
    await socktRef.current.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
      // The server sends back params needed 
      // to create Send Transport on the client side
      if (params.error) {
        console.log(params.error)
        return
      }
      console.log('PARAMS... ', params);
      if (device.current === undefined) console.log('device not available ');
      console.log('device is ', device.current);
      let consumerTransportt
      try {
        consumerTransportt = device.current.createRecvTransport(params)
        console.log('value of consumertranportt is ', consumerTransportt);
      } catch (error) {
        // exceptions: 
        // {InvalidStateError} if not loaded
        // {TypeError} if wrong arguments.
        console.log(error)
        return
      }
      consumerTransportt.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          // Signal local DTLS parameters to the server side transport
          // see server's socket.on('transport-recv-connect', ...)
          console.log('entered connect event ')
          await socktRef.current.emit('transport-recv-connect', {
            dtlsParameters,
            serverConsumerTransportId: params.id,
          })
          console.log('transport-recv-connect  here ')
          // Tell the transport that parameters were transmitted.
          callback();
          console.log('transport-recv-connect  here ')
        } catch (error) {
          // Tell the transport that something was wrong
          errback(error)
        }
      })
      console.log('reached till the end in create recv ');
      connectRecvTransport(consumerTransportt, remoteProducerId, params.id);
    })
  };
  const createSendTransport = useCallback((newDevice) => {
    console.log('In createSendTransport. Device:', newDevice);
    if (!socktRef.current || !newDevice) {
      console.error("❌ Socket or Device not initialized in send transport");
      return;
    }
    // setDevice(newDevice);
    console.log("🟢 Requesting WebRTC Transport...");
    socktRef.current.emit("createWebRtcTransport", { consumer: false }, ({ params }) => {
      if (!params || params.error) {
        console.error("❌ Error receiving transport parameters:", params?.error);
        return;
      }
      console.log("✅ Received Transport Params:", params);
      let newTransport;
      try {
        newTransport = newDevice.createSendTransport(params);
        setProducerTransport(newTransport);
        console.log('new transport is ', newTransport);
        newTransport.on("connect", async ({ dtlsParameters }, callback, errback) => {
          console.log("🔗 Connecting transport in connect event...");
          try {
            await socktRef.current.emit("transport-connect", { dtlsParameters });
            callback();
          } catch (error) {
            console.error("❌ Transport connection failed:", error);
            errback(error);
          }
        });
        newTransport.on("produce", async (parameters, callback, errback) => {
          console.log("📡 Producing stream...", parameters);
          try {
            socktRef.current.emit(
              "transport-produce",
              {
                kind: parameters.kind,
                rtpParameters: parameters.rtpParameters,
                appData: parameters.appData,
              },
              ({ id, producersExist }) => {
                console.log("✅ Producer ID received:", id, producersExist);
                callback({ id });
                if (producersExist) {
                  getProducers()
                }
              }
            );
          } catch (error) {
            console.error("❌ Producer error:", error);
            errback(error);
          }
        });
        console.log('device value in create send trprt ', device.current);
        connectSendTransport(newTransport);
      } catch (error) {
        console.error("❌ Error creating send transport:", error);
      }
    });
  }, [connectSendTransport]);
  const createDevice = useCallback(async (rtpCaps) => {
    console.log('Entered createDevice');
    if (!rtpCaps) {
      console.error("❌ RTP Capabilities not available yet.");
      return;
    }
    try {
      const newDevice = new mediasoupClient.Device();

      console.log('Device created:', newDevice);

      // Load the device with RTP capabilities from the backend (router)
      await newDevice.load({
        routerRtpCapabilities: rtpCaps,  // Use passed parameter instead of state
      });

      console.log('✅ Device loaded with RTP Capabilities:', newDevice.rtpCapabilities);



      // Based on whether the user is a producer or consumer, create appropriate transport
      // setDevice(newDevice);
      device.current = newDevice;
      console.log('new device value is ', device.current);
      createSendTransport(newDevice);

    } catch (error) {
      console.error("❌ Error creating device:", error);
      if (error.name === 'UnsupportedError') {
        console.warn('❌ Browser does not support Mediasoup');
      }
    }
  }, [])
  const joinRoom = useCallback(() => {
    console.log("join room function called");
    socktRef.current?.emit("join-room", { roomName }, (data) => {
      console.log("router rtp caps in join room is ", data);
      setRtpCapabilities(data.rtpCapabilities);
      createDevice(data.rtpCapabilities);
    });
  }, [roomName]);
  const streamSuccess = useCallback(
    (newStream) => {
      console.log("4 Entered streamSuccess");
      if (localVideoRef.current) {
        console.log("Setting local video stream...");
        localVideoRef.current.srcObject = newStream;
        console.log("5 Value of local video ref is:", localVideoRef);
        const track = newStream.getVideoTracks()[0];
        console.log("6 Value of the track is:", track);
        if (socktRef.current) {
          setParams((prev) => ({ track, ...prev }));
          console.log("7 Value of params is:", params);
        
          // 🔁 Add 1-second delay before calling joinRoom
          setTimeout(() => {
            joinRoom();
          }, 5000);
        } else {
          console.error("❌ Socket is not yet initialized, waiting...");
          setTimeout(() => {
            if (socktRef.current) {
              setParams((prev) => ({ track, ...prev }));
              joinRoom();
            } else {
              console.error("❌ Still no socket, retrying failed.");
            }
          }, 500);
        }
      } else {
        console.error("❌ localVideo element not found!");
      }
    },
    [joinRoom, params]
  );
  const getLocalStream = useCallback(async (selCameraId) => {
    try {
      console.log("Requesting local stream with audio:", audio, "and video:", video);
      const constraints = {
        audio,
        // video: selCameraId ? { deviceId: { exact: selCameraId } } : video,
        video:video
      };
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(newStream);
      newLocalStream.current = newStream;
      console.log("3 New stream is:", newLocalStream);
      streamSuccess(newStream);
    } catch (error) {
      console.error("❌ Error accessing media devices:", error.message);
    }
  }, [audio, video, streamSuccess, ]);

  const handleAudio = () => {
    if (stream) {
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setAudio(audioTrack.enabled);
        console.log("Audio track toggled. Audio enabled:", audioTrack.enabled);
      }
    }
  };

  const handleVideo = () => {
    if (stream) {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setVideo(videoTrack.enabled);
        console.log("Video track toggled. Video enabled:", videoTrack.enabled);
      }
    }
  };
  const removeRemoteStream = (id) => {
    remoteStreamsMap.current.delete(id);
    setRemoteStreams(Array.from(remoteStreamsMap.current.entries()));
  };

  useEffect(() => {
    const socket = io("https://localhost:5000", {
      transports: ["websocket"],
      secure: true,
      rejectUnauthorized: false,
    });

    console.log("Socket initialized:", socket);
    socktRef.current = socket; // ✅ store socket in ref
    socket.on("connection-success", handleConnSuccess);
    // socket.on('new-producer', ({ producerId }) => console.log('new producer joined is ',producerId));
    socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))
    socket.on('producer-closed',({remoteProducerId})=>{
      const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
      producerToClose.consumerTransport.close()
      producerToClose.consumer.close()
      let tempConsumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)
      setConsumerTransports(tempConsumerTransports);

    })
    return () => { 
      socket.off("connection-success", handleConnSuccess);
      socket.off('new-producer', ({ producerId }) => console.log('new producer joined is ', producerId));
      socket.disconnect();
    };
  }, [handleConnSuccess]);
  // useEffect(() => {
  //   setRemoteStreams([...remoteStreamsRef.current]);
  // }, []);

  // useEffect(() => {
  //   const fetchCameras = async () => {
  //     try {
  //       const devices = await navigator.mediaDevices.enumerateDevices();
  //       const videoDevices = devices.filter((device) => device.kind === "videoinput");
  //       setCameras(videoDevices);
  //       if (videoDevices.length > 0 && !selectedCameraId) {
  //         setSelectedCameraId(videoDevices[0].deviceId);
  //       }
  //     } catch (err) {
  //       console.error("Error fetching cameras", err);
  //     }
  //   };

  //   fetchCameras();
  // }, []);

  // const initSocketAndStream = (cameraId) => {
  //   const socket = io("https://localhost:5000", {
  //     transports: ["websocket"],
  //     secure: true,
  //     rejectUnauthorized: false,
  //   });
  
  //   socktRef.current = socket;
  
  //   socket.on("connection-success", () => {
  //     console.log("Reconnected socket, getting stream...");
  //     getLocalStream(cameraId); // use selected camera id
  //   });
  
  //   socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId));
  // };

  // useEffect(() => {
  //   if (selectedCameraId) {
  //     initSocketAndStream(selectedCameraId);
  //   }
  // }, [selectedCameraId]);
    
  // const handleCameraChange = async (e) => {
  //   const newDeviceId = e.target.value;
  
  //   // Disconnect existing socket + media
  //   if (socktRef.current) {
  //     socktRef.current.disconnect();
  //     socktRef.current = null;
  //   }
  
  //   // Stop all media tracks from old stream
  //   if (stream) {
  //     stream.getTracks().forEach(track => track.stop());
  //     setStream(null);
  //   }
  
  //   setSelectedCameraId(newDeviceId);
  
  //   // Small delay to allow cleanup before reinitializing
  //   setTimeout(() => {
  //     initSocketAndStream(newDeviceId);
  //   }, 300);
  // };
  
  return (
    <div className="w-full p-4 bg-gray-100 min-h-screen">
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        {/* Local Video */}

        <div className="flex flex-col items-center w-full md:w-1/4">
          <video
            id="localVideo"
            autoPlay
            className="w-60 h-40 bg-black p-2 rounded-lg shadow-lg"
            ref={localVideoRef}
          ></video>
          <p className="mt-2 text-center text-sm text-gray-700">You</p>
        </div>

        {/* Remote Videos */}

        {remoteStreams.map((remote, index) => (
          <div key={remote.id} className="flex flex-col items-center">
            <video
              autoPlay
              playsInline
              className="w-60 h-40 bg-black p-2 rounded-lg shadow"
              ref={(el) => {
                if (el) el.srcObject = remote.stream;
              }}
            ></video>
            <p className="mt-2 text-center text-xs text-gray-500">User {index + 1}</p>
          </div>
        ))}
        
      </div>

      {/* Controls */}
      <div className="flex flex-wrap justify-center gap-4 mt-4">
        {/* <select
          value={selectedCameraId}
          // onChange={(e) => setSelectedCameraId(e.target.value)}
          onChange={handleCameraChange}
          className="p-2 border rounded"
        >
          {cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label || `Camera ${camera.deviceId}`}
            </option>
          ))}
        </select> */}
        <button className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600">Start Call</button>
        <button className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600">End Call</button>
        <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          onClick={handleAudio}>Mute</button>
        <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          onClick={handleVideo}>Video</button>
        <button className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600">Screen Share</button>
        <button className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600">Add Participant</button>
      </div>
    </div>
  );
};

export default VideoConference;