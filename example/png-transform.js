const Transform = require('stream').Transform
var zlib = require('zlib')

const crc32 = require('buffer-crc32')

class PNGTransform extends Transform {
  constructor (width, height, depth, format) {
    super()
    this.width = width
    this.height = height
    this.depth = depth
    this.format = 0
    if (format === 'RGB') {
      this.format = 2
    }
    this.currentLineConsumed = 0
    this.currentLineLength = width * (depth / 8) * (format === 'RGB' ? 3 : 1)
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
    this._zlib.write(readLine(data), done)
  }
  _transform (data, encoding, done) {
    if (!this.headerWritten) {
      this.headerWritten = true
      this.push(new Buffer([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ])) // png magic number
      var chunk = new Buffer(13)
      chunk.writeUInt32BE(this.width, 0)
      chunk.writeUInt32BE(this.height, 4)
      chunk[8] = this.depth // bits
      chunk[9] = this.format // color type (0 = Gray, 2 = RGB)
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

module.exports = PNGTransform
