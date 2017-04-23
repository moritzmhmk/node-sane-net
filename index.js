const net = require('net')
const path = require('path')
const fs = require('fs')

const crc32 = require('buffer-crc32')
var zlib = require('zlib')

const sane = require('./sane')

let width, height

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
  var action = 1
  var valueType = data[option].type
  var value = 120
  return saneClient.controlOption(handle, option, action, value, valueType)
})
.then((data) => {
  console.log('control option response', data)
  var handle = 0 // TODO use actual handle
  return saneClient.getParameters(handle)
})
.then((data) => {
  console.log('get parameters response', data)
  width = data.pixelsPerLine
  height = data.lines
  var handle = 0 // TODO use actual handle
  return saneClient.start(handle)
})
.then((data) => {
  console.log('start response', data)
  var png = fs.createWriteStream(path.join(__dirname, '/scan.png'))
  console.log(width, height)
  var saneTransform = new SaneImageTransform(width, height)
  var pngTransform = new PNGTransform(width, height)

  var dataSocket = new net.Socket()
  dataSocket.pipe(saneTransform).pipe(pngTransform).pipe(png)
  dataSocket.on('error', (err) => { console.log(err) })
  dataSocket.connect(data.port, '127.0.0.1')
})
.catch((reason) => { console.log('promise rejected', reason) })

const Transform = require('stream').Transform

class SaneImageTransform extends Transform {
  constructor (width, height) {
    super()
    this.currentChunkConsumed = 0
    this.currentChunkLength = 0
  }
  readChunk (data) {
    // console.log('->readChunk')
    if (data.length === 0) { return data }
    if (this.currentChunkLength === this.currentChunkConsumed) {
      if (data.length < 4) { console.warn('cant read int 32', data.length) }
      this.currentChunkLength = data.readInt32BE()
      this.currentChunkConsumed = 0
      return this.readChunk(data.slice(4))
    }
    if (this.currentChunkLength === -1) {
      console.log('end of SANE pixel stream')
      return new Buffer(0)
    }
    let chunk = data.slice(0, this.currentChunkLength - this.currentChunkConsumed)
    this.currentChunkConsumed += chunk.length
    return Buffer.concat([chunk, this.readChunk(data.slice(chunk.length))])
  }
  _transform (data, encoding, done) {
    console.log('->transform')
    this.push(this.readChunk(data))
    return done()
  }
}

class PNGTransform extends Transform {
  constructor (width, height) {
    super()
    this.width = width
    this.height = height
    this.currentLineConsumed = 0
    this.currentLineLength = width * 3 // TODO
    this.firstLine = false
    this.headerWritten = false
    this._zlib = zlib.createDeflate()
    this._zlib.on('data', (data) => {
      this.writePNGChunk('IDAT', data)
    })
  }
  writePNGChunk (id, data) {
    console.log('->writePNGChunk', id)
    data = new Buffer(data)
    var header = new Buffer(8)
    header.writeUInt32BE(data.length, 0)
    header.write(id, 4, 4, 'ascii')
    this.push(header)
    if (data.length) { this.push(data) }
    this.push(crc32(data, crc32(header.slice(4))))
  }
  writePixels (data, done) {
    let readLine = (data) => {
      let filter = new Buffer(0)
      if (this.currentLineConsumed === 0) {
        filter = new Buffer([0])
      }
      let lineLeft = this.currentLineLength - this.currentLineConsumed
      if (data.length > lineLeft) {
        let end = data.slice(0, lineLeft)
        this.currentLineConsumed = 0
        return Buffer.concat([filter, end, readLine(data.slice(lineLeft))])
      } else {
        this.currentLineConsumed += data.length
        return Buffer.concat([filter, data])
      }
    }
    // var output = pako.deflate(readLine(data))
    this._zlib.write(readLine(data), done)
    // console.log('->writePixels', lines)
    // this.writePNGChunk('IDAT', output)
  }
  _transform (data, encoding, done) {
    // console.log('->transform')
    if (!this.headerWritten) {
      this.headerWritten = true
      this.push(new Buffer([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ])) // png magic number
      var chunk = new Buffer(13)
      chunk.writeUInt32BE(this.width, 0)
      chunk.writeUInt32BE(this.height, 4)
      chunk[8] = 8 // bits
      chunk[9] = 2 // color type (2 = RGB)
      chunk[10] = 0 // compression
      chunk[11] = 0 // filter
      chunk[12] = 0 // interlace
      this.writePNGChunk('IHDR', chunk)
    }
    return this.writePixels(data, done)
  }
  _flush (done) {
    this._zlib.once('end', () => {
      this.writePNGChunk('IEND', new Buffer(0))
      done()
    })
    this._zlib.end()
  }
}
