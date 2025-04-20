import express from 'express';
import https from 'httpolyglot';
import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';
import dotenv from 'dotenv'
const app = express();
const __dirname = path.resolve();
dotenv.config();
// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8'),
};

const httpsServer = https.createServer(options, app);
console.log('process.env.PORT',process.env.PORT);
httpsServer.listen(process.env.PORT,'0.0.0.0', () => {
  console.log('Server listening on port: 5000');
});

const io = new Server(httpsServer);

// socket.io namespace (could represent a room?)


let worker;
let rooms = {}; // { roomName: { Router, peers: [socketId, ...] } }
let peers = {}; // { socketId: { roomName, transports: [], producers: [], consumers: [] } }
let transports = []; // [ { socketId, roomName, transport, consumer }, ... ]
let producers = []; // [ { socketId, roomName, producer }, ... ]
let consumers = []; // [ { socketId, roomName, consumer }, ... ]

// Create a mediasoup worker
const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`Worker PID: ${worker.pid}`);

  worker.on('died', () => {
    console.error('Mediasoup worker died!');
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

// Initialize worker
createWorker();

// Define media codecs supported by mediasoup
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];
app.get("/", (req, res) => {
  res.send("Secure WebSocket server is running!");
});
// Handle incoming socket connections
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.emit('connection-success', { socketId: socket.id });
    const removeItems = (items, socketId, type) => {
    items.forEach(item => {
      if (item.socketId === socket.id) {
        item[type].close()
      }
    })
    items = items.filter(item => item.socketId !== socket.id)

    return items
  }
  socket.on('disconnect', () => {
    // console.log('Peer disconnected:', socket.id);

    // // Remove the producer entry with this socket.id
    // const index = producers.findIndex(p => p.socketId === socket.id);
    // if (index !== -1) {
    //   producers.splice(index, 1);
    //   console.log(`Producer with socketId ${socket.id} removed.`);
    // }
    const removeItems = (items, socketId, type) => {
      items.forEach(item => {
        if (item.socketId === socket.id) {
          item[type].close()
        }
      })
      items = items.filter(item => item.socketId !== socket.id)
  
      return items
    }
    console.log('peer disconnected')
    consumers = removeItems(consumers, socket.id, 'consumer')
    producers = removeItems(producers, socket.id, 'producer')
    transports = removeItems(transports, socket.id, 'transport')

    const { roomName } = peers[socket.id]
    delete peers[socket.id]

    // remove socket from room
    rooms[roomName] = {
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
    }
    // console.log('producers are ',producers);
  });

  socket.on('join-room', async ({ roomName }, callback) => {
    console.log('join room  is called ');
    const router = await createRoom(roomName, socket.id);
    peers[socket.id] = {
      socket,
      roomName,
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: { name: '', isAdmin: false },
    };
    callback({ rtpCapabilities: router.rtpCapabilities });
  });

  const createRoom = async (roomName, socketId) => {
    console.log('createRoom fucntion ')
    let router;
    let peersList = [];
    if (rooms[roomName]) {
      router = rooms[roomName].router;
      peersList = rooms[roomName].peers;
    } else {
      router = await worker.createRouter({ mediaCodecs });
    }
    console.log(`Router ID: ${router.id}, Peers: ${peersList.length}`);
    rooms[roomName] = { router, peers: [...peersList, socketId] };
    return router;
  };
  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    // get Room Name from Peer's properties
    const roomName = peers[socket.id].roomName

    // get Router (Room) object this peer is in based on RoomName
    const router = rooms[roomName].router
    console.log('router sent to create web rtc ',router);

    createWebRtcTransport(router).then(
      transport => {
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          }
        })
        console.log('callback is sent')
        // add transport to Peer's properties
        addTransport(transport, roomName, consumer)
      },
      error => {
        console.log(error)
      })
  })
  const addProducer = (producer, roomName) => {
    console.log('add producers fucntion ')
    producers = [
      ...producers,
      { socketId: socket.id, producer, roomName, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      producers: [
        ...peers[socket.id].producers,
        producer.id,
      ]
    }
  }
  const informConsumers = (roomName, socketId, id) => {
    console.log('informConsumers fucntion ')
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`)
    // A new producer just joined
    // let all consumers to consume this producer
    producers.forEach(producerData => {
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = peers[producerData.socketId].socket
        // use socket to send producer id to producer
        producerSocket.emit('new-producer', { producerId: id })
      }
    })
  }
  const getTransport = (socketId) => {
    console.log('getTransport fucntion ')
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    return producerTransport.transport
  }

  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    console.log('transport produce event called ')
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    })

    // add producer to the producers array
    const { roomName } = peers[socket.id]

    addProducer(producer, roomName)

    informConsumers(roomName, socket.id, producer.id)

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })
    console.log('producers are in transport-produce',producers);
    console.log('producers.length',producers.length);
    let flag=producers.length>1?true:false;
    console.log('producers exists value',flag);
    // Send back to the client the Producer's id
    callback({
      id: producer.id,
      producersExist: flag
    })
  })

  socket.on('getProducers', callback => {
    //return all producer transports
    console.log('get producers event called ');
    const { roomName } = peers[socket.id]

    let producerList = []
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        producerList = [...producerList, producerData.producer.id]
      }
    })
    console.log('in get producers event , producer list is ',producerList);
    // return the producer list back to the client
    callback(producerList)
  })
  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    console.log(`DTLS PARAMS in transport recv event : ${dtlsParameters}`)
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport
    await consumerTransport.connect({ dtlsParameters })
    console.log('transport-recv-connect event done');
  })
  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      console.log('consume event triggered ');
      const { roomName } = peers[socket.id]
      const router = rooms[roomName].router
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id == serverConsumerTransportId
      )).transport

      // check if the router can consume the specified producer

      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
          socket.emit('producer-closed', { remoteProducerId })
          consumerTransport.close([])
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id)
          consumer.close()
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id)
        })

        addConsumer(consumer, roomName)

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })
  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    console.log('consumer resume')
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId)
    await consumer.resume()
  })
  const addConsumer = (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ]

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...peers[socket.id].consumers,
        consumer.id,
      ]
    }
  }
  const addTransport = (transport, roomName, consumer) => {

    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],  
      transports: [
        ...peers[socket.id].transports,
        transport.id,
      ]
    }
  }
const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '0.0.0.0', // replace with relevant IP address
            announcedIp: '10.22.6.161',
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      }

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options)
      console.log(`transport id: ${transport.id}`)

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close()
        }
      })

      transport.on('close', () => {
        console.log('transport closed')
      })

      resolve(transport)

    } catch (error) {
      reject(error)
    }
  })
}
});



