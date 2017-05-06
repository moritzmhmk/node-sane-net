const net = require('net')
const path = require('path')
const fs = require('fs')

const sane = require('../sane')
const PNGTransform = require('./png-transform')

let width, height, depth, format

let saneClient = new sane.Socket()
saneClient.on('authorize', (backend, callback) => {
  console.log(`backend "${backend}" requires authorization`)
  callback('moritz', 'test')
})
saneClient.connect(6566, '127.0.0.1')
.then(() => saneClient.init())
.then((data) => {
  console.log('init response', data)
  return saneClient.getDevices()
})
.then((data) => {
  console.log('get devices response', data)
  return saneClient.open(data[0].name)
})
.then((data) => {
  console.log('open device response', data)
  return saneClient.getOptionDescriptors(data)
})
.then((data) => {
  console.log('get option descriptors response', data)
  var handle = 0 // TODO use actual handle
  var option = 7
  var value = 120
  return saneClient.setOption(handle, option, value)
})
.then((data) => {
  console.log('set option response', data)
  var handle = 0 // TODO use actual handle
  return saneClient.getParameters(handle)
})
.then((data) => {
  console.log('get parameters response', data)
  width = data.pixelsPerLine
  height = data.lines
  depth = data.depth
  format = data.format
  var handle = 0 // TODO use actual handle
  return saneClient.start(handle)
})
.then((data) => {
  console.log('start response', data)
  var png = fs.createWriteStream(path.join(__dirname, '/scan.png'))
  console.log(width, height)
  var saneTransform = new sane.ImageTransform()
  var pngTransform = new PNGTransform(width, height, depth, format)

  var dataSocket = new net.Socket()
  dataSocket.pipe(saneTransform).pipe(pngTransform).pipe(png)
  dataSocket.on('error', (err) => { console.log(err) })
  dataSocket.connect(data.port, '127.0.0.1')
})
.catch((reason) => { console.log('promise rejected', reason) })
