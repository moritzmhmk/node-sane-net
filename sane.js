const net = require('net')
const EventEmitter = require('events')

const md5 = require('md5')

const sanetypes = require('./sanetypes')

class SaneSocket {
  constructor () {
    this.responseParsers = []
    this.socket = new net.Socket()
    this.socket.on('data', (data) => {
      console.log('Received:', data)
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
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_INIT)
    var versionCode = sanetypes.versionCode(1, 0, 3)
    var name = sanetypes.string('moritz')
    var buf = Buffer.concat([rpcCode, versionCode, name])
    return this.send(buf, new InitParser())
  }
  getDevices () {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_GET_DEVICES)
    console.log(GetDevicesParser)
    return this.send(rpcCode, new GetDevicesParser())
  }
  open (deviceName) {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_OPEN)
    var buf = Buffer.concat([rpcCode, sanetypes.string(deviceName)])
    return this.send(buf, new OpenParser())
  }
  authorize (resource, username, password, originalParser) {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_AUTHORIZE)
    var salt = resource.split('$MD5$')[1]
    var pw = '$MD5$' + md5(salt + password)
    var buf = Buffer.concat([rpcCode, sanetypes.string(resource), sanetypes.string(username), sanetypes.string(pw)])
    return this.send(buf, new AuthorizeParser(originalParser))
  }
  getOptionDescriptors (handle) {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_GET_OPTION_DESCRIPTORS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetOptionDescriptorsParser())
  }
  getParameters (handle) {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_GET_PARAMETERS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetParametersParser())
  }
  start (handle) {
    var rpcCode = sanetypes.word(sanetypes.rpc.SANE_NET_START)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new StartParser())
  }
}

module.exports.Socket = SaneSocket

/**
* A byte is encoded as an 8 bit value.
* Since the transport protocol is assumed to be byte-orientd, the bit order is irrelevant.
*
* @param size number of bytes - defaults to one
*/
class SaneBytes {
  constructor (size) {
    this.size = size !== undefined ? size : 1
    this.received = 0
    this.buffer = new Buffer(size)
  }
  get complete () {
    return this.received === this.size
  }
  get buf () {
    return this.buffer
  }
  get data () {
    return this.buffer
  }
  set data (data) {
    this.buffer.fill(data)
    this.received = this.size
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

/**
* A word is encoded as 4 bytes (32 bits).
* The bytes are ordered from most-significant to least-significant byte (big-endian byte-order).
*
* @param type type of value this word encodes see TODO
*/
class SaneWord {
  static get type () { // TODO move to some enum collection
    return {
      'BOOL': 0,
      'INT': 1,
      'FIXED': 2
    }
  }
  constructor (type) {
    this.type = type
    this.buffer = new SaneBytes(4)
  }
  get complete () {
    return this.buffer.complete
  }
  get buf () {
    return Buffer.concat([this.buffer.buf])
  }
  get data () {
    let i = this.buffer.data.readInt32BE() // TODO signed or unsinged?
    if (this.type === SaneWord.type.BOOL) { return i }
    if (this.type === SaneWord.type.INT) { return i }
    if (this.type === SaneWord.type.FIXED) { return i / (1 << 16) }
    return i
  }
  set data (i) {
    if (this.type === SaneWord.type.FIXED) { i = i * (1 << 16) }
    let buf = new Buffer(4)
    buf.writeInt32BE(i) // TODO signed or unsinged?
    this.buffer.data = buf
  }
  sliceFrom (buf) {
    buf = this.buffer.sliceFrom(buf)
    return buf
  }
}

/**
* A character is currently encoded as an 8-bit ISO LATIN-1 value.
* NOTE: An extension to support wider character sets (16 or 32 bits) is planned for the future,
* but not supported at this point.
*/
class SaneChar {
  constructor () {
    this.buffer = new SaneBytes(1)
  }
  get complete () {
    return this.buffer.complete
  }
  get buf () {
    return this.buffer.buf
  }
  get data () {
    return this.buffer.data
  }
  set data (c) {
    let buf = new Buffer(c)
    this.buffer.data = buf
  }
  sliceFrom (buf) {
    buf = this.buffer.sliceFrom(buf)
    return buf
  }
}

/**
* A SanePointer is encoded by a word that indicates whether the pointer is a NULL-pointer which is
* then (in the case of a non-NULL pointer) followed by the value that the pointer points to.
* The word is 0 in case of a non-NULL pointer (sic!).
* In the case of a NULL pointer, no bytes are encoded for the pointer value.
*
* @param pointerBuffer the buffer to store the value of the pointer
*/
class SanePointer {
  constructor (pointerBuffer) {
    this.isNullBuffer = new SaneWord(SaneWord.type.BOOL)
    this.pointerBuffer = pointerBuffer
  }
  get complete () {
    return this.isNull || this.pointerBuffer.complete
  }
  get isNull () {
    return this.isNullBuffer.complete && this.isNullBuffer.data
  }
  get buf () {
    if (this.isNull) { return this.isNullBuffer.buf }
    return Buffer.concat([this.isNullBuffer.buf, this.pointerBuffer.buf])
  }
  get data () {
    return this.isNull ? null : this.pointerBuffer.data
  }
  set data (data) {
    this.isNullBuffer.data = data === null
    this.pointerBuffer.data = data
  }
  sliceFrom (buf) {
    buf = this.isNullBuffer.sliceFrom(buf)
    if (!this.isNull) {
      buf = this.pointerBuffer.sliceFrom(buf)
    }
    return buf
  }
}

/**
* A structure is encoded by simply encoding the structure members in the order in which they appear.
*
* @param structDefinition definition of the struct in the format [ {name: 'name', bufferCreator: () => new SaneBuffer()}, ...] // TODO
*/
class SaneStructure {
  constructor (structDefinition) {
    this.structDefinition = structDefinition
  }
  get complete () {
    return !this.structDefinition.find((def) => { return !def.buffer || !def.buffer.complete })
  }
  get buf () {
    return Buffer.concat(this.structDefinition.map((def) => { return def.buffer && def.buffer.buf }))
  }
  get data () {
    let data = {}
    this.structDefinition.forEach((def) => {
      if (def.buffer && def.buffer.complete) {
        data[def.name] = def.buffer.data
      }
    })
    return data
  }
  set data (data) {
    console.log(data)
    this.structDefinition.forEach((def) => {
      def.buffer = def.bufferCreator(data)
      def.buffer.data = data[def.name]
    })
  }
  sliceFrom (buf) {
    for (let i = 0; i < this.structDefinition.length; i++) {
      if (!this.structDefinition[i].buffer) {
        this.structDefinition[i].buffer = this.structDefinition[i].bufferCreator(this.data)
      }
      if (!this.structDefinition[i].buffer.complete) {
        buf = this.structDefinition[i].buffer.sliceFrom(buf)
      }
      if (!this.structDefinition[i].buffer.complete) {
        break
      }
    }
    return buf
  }
}

/**
* An array is encoded by a word that indicates the length of the array
* followed by the values of the elements in the array.
* The length may be zero in which case no bytes are encoded for the element values.
*
* @param itemBufferCreator function that returns a new SaneBuffer. Called for every array element.
*/
class SaneArray {
  constructor (itemBufferCreator) {
    this.lengthBuffer = new SaneWord(SaneWord.type.INT)
    this.buffer = []
    this.itemBufferCreator = itemBufferCreator
  }
  get complete () {
    if (!this.lengthBuffer.complete) { return false }
    let complete = true
    for (let i = 0; i < this.buffer.length; i++) {
      complete = this.buffer[i] && this.buffer[i].complete
      if (!complete) { break }
    }
    return complete
  }
  get buf () {
    let _ = this.buffer.map((item) => { return item.buf })
    _.unshift(this.lengthBuffer.buf)
    return Buffer.concat(_)
  }
  get data () {
    return this.buffer.map((item) => { return item ? item.data : undefined })
  }
  set data (data) {
    this.lengthBuffer.data = data.length
    this.buffer = new Array(data.length)
    for (let i = 0; i < data.length; i++) {
      this.buffer[i] = this.itemBufferCreator(i)
      this.buffer[i].data = data[i]
    }
  }
  sliceFrom (buf) {
    if (!this.lengthBuffer.complete) {
      buf = this.lengthBuffer.sliceFrom(buf)
      if (this.lengthBuffer.complete) {
        this.buffer = new Array(this.lengthBuffer.data).fill(0) // TODO why is fill(0) required
        this.buffer = this.buffer.map((_, i) => { return this.itemBufferCreator(i) })
      }
    }
    for (let i = 0; i < this.buffer.length; i++) {
      if (!this.buffer[i].complete) { buf = this.buffer[i].sliceFrom(buf) }
    }
    return buf
  }
}

/**
* A string pointer is encoded as a SaneArray of SaneChar.
* The trailing NUL byte is considered part of the array.
* A NULL pointer is encoded as a zero-length array.
*/
class SaneString {
  constructor () {
    this.buffer = new SaneArray((i) => { return new SaneChar() })
  }
  get complete () {
    return this.buffer.complete
  }
  get buf () {
    return this.buffer.buf
  }
  get data () {
    let str = this.buffer.data.join('')
    str = str.slice(-1) === '\0' ? str.slice(0, -1) : str
    return str
  }
  set data (str) {
    str = str.slice(-1) === '\0' ? str : str + '\0'
    this.buffer.data = str.split('')
  }
  sliceFrom (buf) {
    buf = this.buffer.sliceFrom(buf)
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
    this.buffer = new SaneStructure([
      {name: 'status', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'version_code', bufferCreator: () => new SaneWord(SaneWord.type.INT)}
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
    this.buffer.devices = new SaneArray((index) => {
      return new SanePointer(new SaneStructure([
        {name: 'name', bufferCreator: () => new SaneString()},
        {name: 'vendor', bufferCreator: () => new SaneString()},
        {name: 'model', bufferCreator: () => new SaneString()},
        {name: 'type', bufferCreator: () => new SaneString()}
      ]))
    })
    this.buffer.status = new SaneWord(SaneWord.type.INT)
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
    this.buffer = new SaneStructure([
      {name: 'status', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'handle', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'resource', bufferCreator: () => new SaneString()}
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
    this.status = new SaneWord(SaneWord.type.INT)
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
    this.buffer = new SaneArray((index) => {
      return new SanePointer(new SaneStructure([
        {name: 'name', bufferCreator: () => new SaneString()},
        {name: 'title', bufferCreator: () => new SaneString()},
        {name: 'description', bufferCreator: () => new SaneString()},
        {name: 'type', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
        {name: 'units', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
        {name: 'size', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
        {name: 'cap', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
        {name: 'constraint', bufferCreator: (optionDescriptor) => new SaneStructure([
          {name: 'type', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
          {name: 'value', bufferCreator: (constraint) => {
            if (constraint.type === 0) { // NONE
              return new SaneBytes(0)
            }
            if (constraint.type === 1) {// RANGE
              return new SanePointer(new SaneStructure([
                {name: 'min', bufferCreator: () => new SaneWord(optionDescriptor.type)},
                {name: 'max', bufferCreator: () => new SaneWord(optionDescriptor.type)},
                {name: 'quantization', bufferCreator: () => new SaneWord(optionDescriptor.type)}
              ]))
            }
            if (constraint.type === 2) {// WORD_LIST
              return new SaneArray((index) => { return new SaneWord(optionDescriptor.type) })
            }
            if (constraint.type === 3) {// STRING_LIST
              return new SaneArray((index) => { return new SaneString() })
            }
          }}
        ])}
      ]))
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
    this.status = new SaneWord(SaneWord.type.INT)
    this.buffer = new SaneStructure([
      {name: 'format', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'last_frame', bufferCreator: () => new SaneWord(SaneWord.type.BOOL)},
      {name: 'bytes_per_line', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'pixels_per_line', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'lines', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'depth', bufferCreator: () => new SaneWord(SaneWord.type.INT)}
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
    this.buffer = new SaneStructure([
      {name: 'status', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'port', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'byte_order', bufferCreator: () => new SaneWord(SaneWord.type.INT)},
      {name: 'resource', bufferCreator: () => new SaneString()}
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
