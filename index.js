const net = require('net')
const md5 = require('md5')

const sanetypes = require('./sanetypes')

let handlers = []

const send = (msg, responseParser) => {
  return new Promise((resolve, reject) => {
    handlers.push((err, data) => {
      if (err) { reject(err) }
      let rest = responseParser.parse(data)
      if (rest) {
        handlers.shift()
        if (rest.lenght) {
          console.warn('The parser', responseParser, 'has rest data', rest)
          handlers[0](rest)
        }
        resolve(responseParser.data)
      }
    })
    client.write(msg)
  })
}

class ReceivingBuffer {
  constructor (size) {
    this.size = size
    this.received = 0
    this.buffer = new Buffer(size)
  }
  get complete () {
    return this.received === this.size
  }
  get data () {
    return this.buffer
  }
  sliceFrom (buf) {
    if (!buf || !buf.length) { return buf } // Buffer.fill hangs when zero-length buffer is passed
    this.buffer.fill(buf, this.received)
    let added = this.size - this.received
    buf = buf.slice(added)
    this.received += added
    return buf
  }
}

class ReceivingStringBuffer {
  constructor () {
    this.lengthBuffer = new ReceivingBuffer(4)
    this.stringBuffer
  }
  get complete () {
    return this.stringBuffer ? this.stringBuffer.complete : false
  }
  get data () {
    return this.stringBuffer ? this.stringBuffer.buffer.toString() : undefined
  }
  sliceFrom (buf) {
    if (!this.lengthBuffer.complete) {
      buf = this.lengthBuffer.sliceFrom(buf)
      if (this.lengthBuffer.complete) {
        this.stringBuffer = new ReceivingBuffer(this.lengthBuffer.buffer.readUInt32BE())
      }
    }
    if (this.lengthBuffer.complete && !this.stringBuffer.complete) {
      buf = this.stringBuffer.sliceFrom(buf)
    }
    return buf
  }
}

class ReceivingPointerBuffer {
  constructor (pointerBuffer) {
    this.isNullBuffer = new ReceivingBuffer(4)
    this.pointerBuffer = pointerBuffer
  }
  get complete () {
    return this.isNull || this.pointerBuffer.complete
  }
  get isNull () {
    return this.isNullBuffer.complete && this.isNullBuffer.buffer.readUInt32BE() === 1
  }
  get data () {
    return this.isNull ? null : this.pointerBuffer.data
  }
  sliceFrom (buf) {
    buf = this.isNullBuffer.sliceFrom(buf)
    if (!this.isNull) {
      buf = this.pointerBuffer.sliceFrom(buf)
    }
    return buf
  }
}

class ReceivingStructBuffer {
  constructor (structDefinition) {
    this.structDefinition = structDefinition
  }
  get complete () {
    return !this.structDefinition.find((def) => { return !def.buffer.complete })
  }
  get data () {
    let data = {}
    this.structDefinition.forEach((def) => {
      if (def.buffer.complete) {
        data[def.name] = def.buffer.data
      }
    })
    return data
  }
  sliceFrom (buf) {
    for (let i = 0; i < this.structDefinition.length; i++) {
      if (!this.structDefinition[i].buffer.complete) {
        buf = this.structDefinition[i].buffer.sliceFrom(buf)
      }
      if (!buf.length) { break }
    }
    return buf
  }
}

class ReceivingArrayBuffer {
  constructor (itemBufferCreator) {
    this.lengthBuffer = new ReceivingBuffer(4)
    this.itemBufferCreator = itemBufferCreator
  }
  get complete () {
    if (!this.buffer) { return false }
    let complete = true
    for (let i = 0; i < this.buffer.length; i++) {
      complete = this.buffer[i] && this.buffer[i].complete
      if (!complete) { break }
    }
    return complete
  }
  get data () {
    return this.buffer ? this.buffer.map((item) => { return item ? item.data : undefined }) : []
  }
  sliceFrom (buf) {
    if (!this.lengthBuffer.complete) {
      buf = this.lengthBuffer.sliceFrom(buf)
      if (this.lengthBuffer.complete) { this.buffer = new Array(this.lengthBuffer.buffer.readUInt32BE()) }
    }
    for (let i = 0; i < this.buffer.length; i++) {
      if (!this.buffer[i]) {
        this.buffer[i] = this.itemBufferCreator(i)
      }
      if (!this.buffer[i].complete) {
        buf = this.buffer[i].sliceFrom(buf)
      }
    }
    return buf
  }
}

class FakeParser {
  parse (data) {
    this.data = data
    return new Buffer(0)
  }
}

class InitParser {
  parse (data) {
    this.data = data.slice(0, 8)
    return data.slice(8)
  }
}

class GetDevicesParser {
  constructor () {
    this.buffer = {}
    this.buffer.devices = new ReceivingArrayBuffer((index) => {
      return new ReceivingPointerBuffer(new ReceivingStructBuffer([
        // {name: '_', buffer: new ReceivingBuffer(4)}, // TODO this word is 1 if this is a NULL Pointer or 0 otherwise
        {name: 'name', buffer: new ReceivingStringBuffer()},
        {name: 'vendor', buffer: new ReceivingStringBuffer()},
        {name: 'model', buffer: new ReceivingStringBuffer()},
        {name: 'type', buffer: new ReceivingStringBuffer()}
      ]))
    })
    this.buffer.status = new ReceivingBuffer(4)
  }
  parse (data) {
    if (!this.buffer.status.complete) {
      data = this.buffer.status.sliceFrom(data)
    }
    if (!this.buffer.devices.complete) {
      data = this.buffer.devices.sliceFrom(data)
    }
    console.log(this.buffer.status.complete, this.buffer.devices.complete)
    return this.buffer.status.complete && this.buffer.devices.complete ? data : undefined
  }
  get data () {
    return {
      devices: this.buffer.devices.data,
      status: this.buffer.status.data
    }
  }
}

class OpenParser {
  constructor () {
    this.buffer = new ReceivingStructBuffer([
      {name: 'status', buffer: new ReceivingBuffer(4)},
      {name: 'handle', buffer: new ReceivingBuffer(4)},
      {name: 'resource', buffer: new ReceivingStringBuffer()}
    ])
  }
  parse (data) {
    data = this.buffer.sliceFrom(data)
    return this.buffer.complete ? data : undefined
  }
  get data () {
    return this.buffer.data
  }
}

class AuthorizeParser {
  constructor (originalParser) {
    this.status = new ReceivingBuffer(4)
    this.originalParser = originalParser
  }
  parse (data) {
    data = this.status.sliceFrom(data)
    return this.originalParser.parse(data)
  }
  get data () {
    return this.originalParser.data // TODO handle failed authorization
  }
}

var globalResource = ''

var client = new net.Socket()
client.connect(6566, '127.0.0.1', () => {
  console.log('Connected')
  var rpcCode = new Buffer(4)
  rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_INIT)
  var versionCode = sanetypes.versionCode(1, 0, 3)
  var name = sanetypes.string('moritz')
  var buf = Buffer.concat([rpcCode, versionCode, name])
  console.log(buf)
  send(buf, new InitParser()) // client.write(buf)
  .then((data) => {
    console.log('init response', data)
  })
  .then(() => send(new Buffer([0, 0, 0, 1]), new GetDevicesParser()))
  .then((data) => {
    console.log('get devices response', data)
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_OPEN)
    var deviceName = sanetypes.string(data.devices[0].name)
    var buf = Buffer.concat([rpcCode, deviceName])
    return send(buf, new OpenParser())
  })
  .then((data) => {
    console.log('open device response', data)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_AUTHORIZE)
    var resource = sanetypes.string(data.resource)
    var username = sanetypes.string('moritz')
    var salt = data.resource.split('$MD5$')[1]
    salt = salt.slice(0, -1) // remove trailing \0
    var password = sanetypes.string('$MD5$' + md5(salt + 'test'))
    var buf = Buffer.concat([rpcCode, resource, username, password])
    return send(buf, new AuthorizeParser(new OpenParser()))
  })
  .then((data) => {
    console.log('authorize response', data)
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_GET_OPTION_DESCRIPTORS)
    var handle = data.handle
    var buf = Buffer.concat([rpcCode, handle])
    return send(buf, new FakeParser())
  })
  .then((data) => {
    console.log('get option descriptors response', data)
  })
  .catch((reason) => { console.log('promise rejected', reason) })
  // client.write(new Buffer([0, 0, 0, 1])
})

client.on('data', (data) => {
  console.log('Received:', data, data.toString())
  handlers[0](null, data)
})

client.on('close', () => {
  console.log('Connection closed')
})
