const net = require('net')

const sane = require('./sane')

let saneClient = new sane.Socket()
saneClient.connect(6566, '127.0.0.1')
.then(() => saneClient.init())
.then((data) => {
  console.log('init response', data)
  return saneClient.getDevices()
})
.then((data) => {
  console.log('get devices response', data)
  return saneClient.open(data.devices[0].name)
})
.then((data) => {
  console.log('open device response', data)
  return saneClient.getOptionDescriptors(data.handle)
})
.then((data) => {
  console.log('get option descriptors response', data)
  var handle = new Buffer([0, 0, 0, 0]) // TODO use actual handle
  return saneClient.getParameters(handle)
})
.then((data) => {
  console.log('get parameters response', data)
  var handle = new Buffer([0, 0, 0, 0]) // TODO use actual handle
  return saneClient.start(handle)
})
.then((data) => {
  console.log('start response', data)
  var dataSocket = new net.Socket()
  dataSocket.pipe(require('fs').createWriteStream(__dirname + '/scan.raw'))
  dataSocket.on('error', (err) => { console.log(err) })
  dataSocket.connect(data.port, '127.0.0.1')
})
.catch((reason) => { console.log('promise rejected', reason) })
