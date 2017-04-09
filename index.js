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

class ReceivingWordBuffer {
  static get type () {
    return {
      'BOOL': 0,
      'INT': 1,
      'FIXED': 2
    }
  }
  constructor (type) {
    this.type = type
    this.buffer = new ReceivingBuffer(4)
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    let i = this.buffer.data.readInt32BE() // TODO signed or unsinged?
    if (this.type === ReceivingWordBuffer.type.BOOL) { return i }
    if (this.type === ReceivingWordBuffer.type.INT) { return i }
    if (this.type === ReceivingWordBuffer.type.FIXED) { return i / (1 << 16) }
    return i
  }
  sliceFrom (buf) {
    buf = this.buffer.sliceFrom(buf)
    return buf
  }
}

class ReceivingDummyBuffer {
  get complete () {
    return true
  }
  get data () {
    return null
  }
  sliceFrom (buf) {
    return buf
  }
}

class ReceivingStringBuffer {
  constructor () {
    this.lengthBuffer = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
    this.stringBuffer
  }
  get complete () {
    return this.stringBuffer ? this.stringBuffer.complete : false
  }
  get data () {
    if (!this.stringBuffer) { return undefined }
    let str = this.stringBuffer.buffer.toString()
    str = str.slice(-1) === '\0' ? str.slice(0, -1) : str
    return str
  }
  sliceFrom (buf) {
    if (!this.lengthBuffer.complete) {
      buf = this.lengthBuffer.sliceFrom(buf)
      if (this.lengthBuffer.complete) {
        this.stringBuffer = new ReceivingBuffer(this.lengthBuffer.data)
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
    this.isNullBuffer = new ReceivingWordBuffer(ReceivingWordBuffer.type.BOOL)
    this.pointerBuffer = pointerBuffer
  }
  get complete () {
    return this.isNull || this.pointerBuffer.complete
  }
  get isNull () {
    return this.isNullBuffer.complete && this.isNullBuffer.data
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
    this.lengthBuffer = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
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
      if (this.lengthBuffer.complete) { this.buffer = new Array(this.lengthBuffer.data) }
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

class ReceivingConstraintBuffer {
  constructor (rangeValueType) {
    this.rangeValueType = rangeValueType
    this.type = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
  }
  get complete () {
    if (!this.type.complete) { return false }
    if (!this.value.complete) { return false }
    return true
  }
  get data () {
    return {
      type: this.type.data,
      value: this.value ? this.value.data : undefined
    }
  }
  sliceFrom (buf) {
    if (!this.type.complete) {
      buf = this.type.sliceFrom(buf)
      if (this.type.complete) {
        if (this.type.data === 0) { // NONE
          this.value = new ReceivingDummyBuffer()
        }
        if (this.type.data === 1) {// RANGE
          this.value = new ReceivingPointerBuffer(new ReceivingStructBuffer([
            {name: 'min', buffer: new ReceivingWordBuffer(this.rangeValueType)},
            {name: 'max', buffer: new ReceivingWordBuffer(this.rangeValueType)},
            {name: 'quantization', buffer: new ReceivingWordBuffer(this.rangeValueType)}
          ]))
        }
        if (this.type.data === 2) {// WORD_LIST
          this.value = new ReceivingArrayBuffer((index) => { return new ReceivingWordBuffer(ReceivingWordBuffer.type.INT) })
        }
        if (this.type.data === 3) {// STRING_LIST
          this.value = new ReceivingArrayBuffer((index) => { return new ReceivingStringBuffer() })
        }
      }
    }

    if (this.type.complete) {
      buf = this.value.sliceFrom(buf)
    }
    console.log(this.complete, this.data)

    return buf
  }
}

class ReceivingOptionDescriptorBuffer {
  constructor () {
    this.structBuffer = new ReceivingStructBuffer([
      {name: 'name', buffer: new ReceivingStringBuffer()},
      {name: 'title', buffer: new ReceivingStringBuffer()},
      {name: 'description', buffer: new ReceivingStringBuffer()},
      {name: 'type', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'units', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'size', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'cap', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)}
    ])
    this.constraintBuffer = new ReceivingConstraintBuffer()
  }
  get complete () {
    return this.structBuffer.complete && this.constraintBuffer && this.constraintBuffer.complete
  }
  get data () {
    let data = Object.assign({}, this.structBuffer.data)
    data.constraint = this.constraintBuffer.data
    return data
  }
  sliceFrom (buf) {
    if (!this.structBuffer.complete) {
      buf = this.structBuffer.sliceFrom(buf)
      if (this.structBuffer.complete) {
        this.constraintBuffer = new ReceivingConstraintBuffer(this.structBuffer.data.type)
      }
    }
    if (this.structBuffer.complete) {
      buf = this.constraintBuffer.sliceFrom(buf)
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
        {name: 'name', buffer: new ReceivingStringBuffer()},
        {name: 'vendor', buffer: new ReceivingStringBuffer()},
        {name: 'model', buffer: new ReceivingStringBuffer()},
        {name: 'type', buffer: new ReceivingStringBuffer()}
      ]))
    })
    this.buffer.status = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
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
      {name: 'status', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
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
    this.status = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
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

class GetOptionDescriptorsParser {
  constructor () {
    this.buffer = {}
    this.buffer.optionDescriptors = new ReceivingArrayBuffer((index) => {
      return new ReceivingPointerBuffer(new ReceivingOptionDescriptorBuffer())
    })
  }
  parse (data) {
    //if (!this.buffer.status.complete) {
    //  data = this.buffer.status.sliceFrom(data)
    //}
    if (!this.buffer.optionDescriptors.complete) {
      data = this.buffer.optionDescriptors.sliceFrom(data)
    }
    // console.log(require('util').inspect(this.buffer.optionDescriptors, false, 10))
    return this.buffer.optionDescriptors.complete ? data : undefined
  }
  get data () {
    return this.buffer.optionDescriptors.data
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
    return send(buf, new GetOptionDescriptorsParser())
  })
  .then((data) => {
    console.log('get option descriptors response', require('util').inspect(data, false, 10))
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
