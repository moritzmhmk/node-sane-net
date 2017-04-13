const net = require('net')
const EventEmitter = require('events')

const md5 = require('md5')

const sanetypes = require('./sanetypes')

class SaneSocket {
  constructor () {
    this.responseParsers = []
    this.socket = new net.Socket()
    this.socket.on('data', (data) => {
      console.debug('Received:', data)
      this._parse(data)
    })
    this.socket.on('close', () => {
      console.log('Connection closed')
    })
  }
  _parse (data) { // TODO avoid infinte loop...
    data = this.responseParsers[0].parse(data)
    if (data.length) {
      if (this.responseParsers[0]) {
        this._parse(data)
      } else {
        console.warn('data not parsed:', data)
      }
    }
  }
  connect (port, ip, callback) {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.once('connect', resolve)
      this.socket.connect(port, ip)
    })
  }
  send (msg, responseParser) {
    return new Promise((resolve, reject) => {
      this.responseParsers.push(responseParser)
      responseParser.once('complete', (data) => this.responseParsers.shift())
      responseParser.once('complete', resolve)
      responseParser.on('authorize', (resource) => {
        this.responseParsers.shift()
        this.authorize(resource, 'moritz', 'test', responseParser)
      })
      this.socket.write(msg)
    })
  }
  init () {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_INIT)
    var versionCode = sanetypes.versionCode(1, 0, 3)
    var name = sanetypes.string('moritz')
    var buf = Buffer.concat([rpcCode, versionCode, name])
    return this.send(buf, new InitParser())
  }
  getDevices () {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_GET_DEVICES)
    console.log(GetDevicesParser)
    return this.send(rpcCode, new GetDevicesParser())
  }
  open (deviceName) {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_OPEN)
    var buf = Buffer.concat([rpcCode, sanetypes.string(deviceName)])
    return this.send(buf, new OpenParser())
  }
  authorize (resource, username, password, originalParser) {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_AUTHORIZE)
    var salt = resource.split('$MD5$')[1]
    var pw = '$MD5$' + md5(salt + password)
    var buf = Buffer.concat([rpcCode, sanetypes.string(resource), sanetypes.string(username), sanetypes.string(pw)])
    return this.send(buf, new AuthorizeParser(originalParser))
  }
  getOptionDescriptors (handle) {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_GET_OPTION_DESCRIPTORS)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetOptionDescriptorsParser())
  }
  getParameters (handle) {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_GET_PARAMETERS)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetParametersParser())
  }
  start (handle) {
    var rpcCode = new Buffer(4)
    rpcCode.writeUInt32BE(sanetypes.rpc.SANE_NET_START)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new StartParser())
  }
}

module.exports.Socket = SaneSocket

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
    let added = Math.min(this.size - this.received, buf.length)
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

class FakeParser extends EventEmitter {
  constructor () {
    super()
  }
  get data () {
    return this.buffer
  }
  get complete () {
    return this.data !== undefined
  }
  parse (data) {
    this.buffer = data
    if (this.complete) { this.emit('complete', this.data) }
    return new Buffer(0)
  }
}

class InitParser extends EventEmitter {
  constructor () {
    super()
    this.buffer = new ReceivingStructBuffer([
      {name: 'status', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'version_code', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)}
    ])
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return this.buffer.data
  }
  parse (data) {
    data = this.buffer.sliceFrom(data)
    if (this.complete) { this.emit('complete', this.data) }
    return data
  }
}

class GetDevicesParser extends EventEmitter {
  constructor () {
    super()
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
  get complete () {
    return this.buffer.status.complete && this.buffer.devices.complete
  }
  get data () {
    return {
      devices: this.buffer.devices.data,
      status: this.buffer.status.data
    }
  }
  parse (data) {
    if (!this.buffer.status.complete) {
      data = this.buffer.status.sliceFrom(data)
    }
    if (!this.buffer.devices.complete) {
      data = this.buffer.devices.sliceFrom(data)
    }
    if (this.complete) { this.emit('complete', this.data) }
    return data
  }
}

class OpenParser extends EventEmitter {
  constructor () {
    super()
    this._resetBuffer()
  }
  _resetBuffer () {
    this.buffer = new ReceivingStructBuffer([
      {name: 'status', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'handle', buffer: new ReceivingBuffer(4)},
      {name: 'resource', buffer: new ReceivingStringBuffer()}
    ])
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return this.buffer.data
  }
  parse (data) {
    data = this.buffer.sliceFrom(data)
    if (this.complete) {
      if (this.data.resource.length) {
        console.log('authorization required', this.data.resource.length, this.data.resource)
        let resource = this.data.resource
        this._resetBuffer()
        this.emit('authorize', resource)
      } else {
        this.emit('complete', this.data)
      }
    }
    return data
  }
}

class AuthorizeParser extends EventEmitter {
  constructor (originalParser) {
    super()
    this.status = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
    this.originalParser = originalParser
  }
  get complete () {
    return this.originalParser.complete
  }
  get data () {
    return this.originalParser.data
  }
  parse (data) {
    data = this.status.sliceFrom(data)
    data = this.originalParser.parse(data)
    if (this.complete) { this.emit('complete', this.data) }
    return data
  }
}

class GetOptionDescriptorsParser extends EventEmitter {
  constructor () {
    super()
    this.buffer = new ReceivingArrayBuffer((index) => {
      return new ReceivingPointerBuffer(new ReceivingOptionDescriptorBuffer())
    })
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return this.buffer.data
  }
  parse (data) {
    data = this.buffer.sliceFrom(data)
    if (this.complete) {
      this.emit('complete', this.data)
    }
    return data
  }
}

class GetParametersParser extends EventEmitter {
  constructor () {
    super()
    this.status = new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)
    this.buffer = new ReceivingStructBuffer([
      {name: 'format', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'last_frame', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.BOOL)},
      {name: 'bytes_per_line', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'pixels_per_line', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'lines', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'depth', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)}
    ])
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return {'status': this.status.data, 'parameters': this.buffer.data}
  }
  parse (data) {
    data = this.status.sliceFrom(data)
    data = this.buffer.sliceFrom(data)
    if (this.complete) {
      this.emit('complete', this.data)
    }
    return data
  }
}

class StartParser extends EventEmitter {
  constructor () {
    super()
    this._resetBuffer()
  }
  _resetBuffer () {
    this.buffer = new ReceivingStructBuffer([
      {name: 'status', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'port', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'byte_order', buffer: new ReceivingWordBuffer(ReceivingWordBuffer.type.INT)},
      {name: 'resource', buffer: new ReceivingStringBuffer()}
    ])
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return this.buffer.data
  }
  parse (data) {
    data = this.buffer.sliceFrom(data)
    if (this.complete) {
      if (this.data.resource.length) {
        console.log('authorization required', this.data.resource.length, this.data.resource)
        let resource = this.data.resource
        this._resetBuffer()
        this.emit('authorize', resource)
      } else {
        this.emit('complete', this.data)
      }
    }
    return data
  }
}
