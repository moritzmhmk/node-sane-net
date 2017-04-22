const net = require('net')
const EventEmitter = require('events')

const md5 = require('md5')

const sanetypes = require('./sanetypes')
const enums = require('./enums')

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
    data = this.responseParsers[0].sliceFrom(data)
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
    console.log('send', msg)
    return new Promise((resolve, reject) => {
      this.responseParsers.push(responseParser)
      responseParser.once('complete', (data) => this.responseParsers.shift())
      responseParser.once('complete', resolve)
      responseParser.on('authorize', (resource) => {
        this.responseParsers.shift()
        this.authorize(resource, 'moritz', 'test', responseParser)
      })
      responseParser.once('error', err => reject(err))
      this.socket.write(msg)
    })
  }
  init () {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_INIT)
    var versionCode = sanetypes.versionCode(1, 0, 3)
    var name = sanetypes.string('moritz')
    var buf = Buffer.concat([rpcCode, versionCode, name])
    return this.send(buf, new InitParser())
  }
  getDevices () {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_DEVICES)
    console.log(GetDevicesParser)
    return this.send(rpcCode, new GetDevicesParser())
  }
  open (deviceName) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_OPEN)
    var buf = Buffer.concat([rpcCode, sanetypes.string(deviceName)])
    return this.send(buf, new OpenParser())
  }
  authorize (resource, username, password, originalParser) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_AUTHORIZE)
    var salt = resource.split('$MD5$')[1]
    var pw = '$MD5$' + md5(salt + password)
    var buf = Buffer.concat([rpcCode, sanetypes.string(resource), sanetypes.string(username), sanetypes.string(pw)])
    return this.send(buf, new AuthorizeParser(originalParser))
  }
  getOptionDescriptors (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_OPTION_DESCRIPTORS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetOptionDescriptorsParser())
  }
  controlOption (handle, option, action, value_type, value_size, value) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_CONTROL_OPTION)
    handle = sanetypes.word(handle)
    option = sanetypes.word(option)
    action = sanetypes.word(action)
    value = sanetypes.array(value, (item) => { return sanetypes.word(item, value_type) })
    value_type = sanetypes.word(value_type)
    value_size = sanetypes.word(value_size)
    var buf = Buffer.concat([rpcCode, handle, option, action, value_type, value_size, value])
    return this.send(buf, new ControlOptionParser())
  }
  getParameters (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_PARAMETERS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new GetParametersParser())
  }
  start (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_START)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new StartParser())
  }
}

module.exports.Socket = SaneSocket

/**
* TODO
*/
class SaneBuffer {
  constructor () {
    if (new.target === SaneBuffer) {
      throw new TypeError('Cannot construct SaneBuffer instances directly')
    }
  }
  reset () { this.buffer.reset() }
  get complete () { return this.buffer.complete }
  static bufferFor (data) { return data }
  get data () { return this.buffer.data }
  sliceFrom (buf) { return this.buffer.sliceFrom(buf) }
}

/**
* A byte is encoded as an 8 bit value.
* Since the transport protocol is assumed to be byte-orientd, the bit order is irrelevant.
*
* @param size number of bytes - defaults to one
*/
class SaneBytes extends SaneBuffer {
  constructor (size) {
    super()
    this.size = size !== undefined ? size : 1
    this.received = 0
    this.buffer = new Buffer(size)
  }
  reset () { this.received = 0 }
  get complete () { return this.received === this.size }
  get data () { return this.buffer }
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
class SaneWord extends SaneBuffer {
  constructor (type) {
    super()
    this.type = type
    this.buffer = new SaneBytes(4)
  }
  static bufferFor (data) {
    if (typeof data !== 'number') { throw new Error('data must be a number') }
    var buf = new Buffer(4)
    if (data !== (data | 0)) { // float
      data = data * (1 << 16)
    }
    buf.writeUInt32BE(data)
    return buf
  }
  get data () {
    let i = this.buffer.data.readInt32BE() // TODO signed or unsinged?
    if (this.type === enums.valueType.BOOL) { return i }
    if (this.type === enums.valueType.INT) { return i }
    if (this.type === enums.valueType.FIXED) { return i / (1 << 16) }
    return i
  }
}

/**
* A character is currently encoded as an 8-bit ISO LATIN-1 value.
* NOTE: An extension to support wider character sets (16 or 32 bits) is planned for the future,
* but not supported at this point.
*/
class SaneChar extends SaneBuffer {
  constructor () {
    super()
    this.buffer = new SaneBytes(1)
  }
  static bufferFor (data) {
    return new Buffer(data)
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
class SanePointer extends SaneBuffer {
  constructor (pointerBuffer) {
    super()
    this.isNullBuffer = new SaneWord(enums.valueType.BOOL)
    this.pointerBuffer = pointerBuffer
  }
  reset () {
    this.isNullBuffer.reset()
    this.pointerBuffer.reset()
  }
  get complete () {
    return this.isNull || this.pointerBuffer.complete
  }
  get isNull () {
    return this.isNullBuffer.complete && this.isNullBuffer.data
  }
  static bufferFor (data) {
    if (data === null) { return SaneWord.bufferFor(1) }
    return Buffer.concat([SaneWord.bufferFor(0), data])
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

/**
* A structure is encoded by simply encoding the structure members in the order in which they appear.
*
* @param structDefinition definition of the struct in the format [ {name: 'name', bufferCreator: () => new SaneBuffer()}, ...] // TODO
*/
class SaneStructure extends SaneBuffer {
  constructor (definitionMap) {
    super()
    this.definitionMap = definitionMap
    this.bufferMap = new Map()
  }
  reset () {
    this.bufferMap = new Map()
  }
  get complete () {
    if (this.bufferMap.size !== this.definitionMap.size) { return false }
    return !Array.from(this.bufferMap.values()).find((buffer) => { return !buffer || !buffer.complete })
  }
  get data () {
    let data = {}
    this.bufferMap.forEach((buffer, name) => { data[name] = buffer.data })
    return data
  }
  sliceFrom (buf) {
    for (let name of this.definitionMap.keys()) {
      if (!this.bufferMap.has(name)) {
        this.bufferMap.set(name, this.definitionMap.get(name)(this.data))
      }
      let buffer = this.bufferMap.get(name)
      if (!buffer.complete) { buf = buffer.sliceFrom(buf) }
      if (!buffer.complete) { break }
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
class SaneArray extends SaneBuffer {
  constructor (itemBufferCreator) {
    super()
    this.lengthBuffer = new SaneWord(enums.valueType.INT)
    this.buffers = []
    this.itemBufferCreator = itemBufferCreator
  }
  reset () {
    this.lengthBuffer.reset()
    this.buffers.forEach((buffer) => buffer && buffer.reset())
  }
  get complete () {
    if (!this.lengthBuffer.complete) { return false }
    let complete = true
    for (let i = 0; i < this.buffers.length; i++) {
      complete = this.buffers[i] && this.buffers[i].complete
      if (!complete) { break }
    }
    return complete
  }
  static bufferFor (data) {
    data.unshift(SaneWord.bufferFor(data.length))
    return Buffer.concat(data)
  }
  get data () {
    return this.buffers.map((buffer) => { return buffer ? buffer.data : undefined })
  }
  sliceFrom (buf) {
    if (!this.lengthBuffer.complete) {
      buf = this.lengthBuffer.sliceFrom(buf)
      if (this.lengthBuffer.complete) {
        this.buffers = new Array(this.lengthBuffer.data).fill(0) // TODO why is fill(0) required
        this.buffers = this.buffers.map((_, i) => { return this.itemBufferCreator(i) })
      }
    }
    for (let i = 0; i < this.buffers.length; i++) {
      if (!this.buffers[i].complete) { buf = this.buffers[i].sliceFrom(buf) }
    }
    return buf
  }
}

/**
* A string pointer is encoded as a SaneArray of SaneChar.
* The trailing NUL byte is considered part of the array.
* A NULL pointer is encoded as a zero-length array.
*/
class SaneString extends SaneBuffer {
  constructor () {
    super()
    this.buffer = new SaneArray((i) => { return new SaneChar() })
  }
  static bufferFor (str) {
    str = str.slice(-1) === '\0' ? str : str + '\0'
    return SaneArray.bufferFor(str.split('').map((c) => SaneChar.bufferFor(c)))
  }
  get data () {
    let str = this.buffer.data.join('')
    str = str.slice(-1) === '\0' ? str.slice(0, -1) : str
    return str
  }
}

class Parser extends EventEmitter {
  constructor () {
    super()
    this.status = new SaneWord(enums.valueType.INT)
    this.buffer = new SaneBytes(0)
    this.resource = new SaneBytes(0)
  }
  get data () { return this.buffer.data }
  get complete () { return this.buffer.complete }
  sliceFrom (data) {
    data = this.status.sliceFrom(data)
    data = this.buffer.sliceFrom(data)
    data = this.resource.sliceFrom(data)
    if (this.complete) {
      let resource = this.resource.data
      if (this.status.data !== enums.status.GOOD) {
        let status = enums.status[this.status.data]
        console.log('error', status)
        this.emit('error', status)
      } else if (resource.length) {
        console.log('authorization required:', resource)
        this.status.reset()
        this.buffer.reset()
        this.resource.reset()
        this.emit('authorize', resource)
      } else {
        this.emit('complete', this.data)
      }
    }
    return data
  }
}

class InitParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneStructure(new Map([
      ['version_code', () => new SaneWord(enums.valueType.INT)]
    ]))
  }
}

class GetDevicesParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneArray((index) => {
      return new SanePointer(new SaneStructure(new Map([
        ['name', () => new SaneString()],
        ['vendor', () => new SaneString()],
        ['model', () => new SaneString()],
        ['type', () => new SaneString()]
      ])))
    })
  }
}

class OpenParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneStructure(new Map([
      ['handle', () => new SaneWord(enums.valueType.INT)]
    ]))
    this.resource = new SaneString()
  }
}

class AuthorizeParser extends Parser {
  constructor (originalParser) {
    super()
    this.buffer = originalParser
  }
}

class GetOptionDescriptorsParser extends Parser {
  constructor () {
    super()
    this.status.sliceFrom(new Buffer([0, 0, 0, 0])) // there is no status response - set to "GOOD" TODO
    this.buffer = new SaneArray((index) => {
      return new SanePointer(new SaneStructure(new Map([
        ['name', () => new SaneString()],
        ['title', () => new SaneString()],
        ['description', () => new SaneString()],
        ['type', () => new SaneWord(enums.valueType.INT)],
        ['units', () => new SaneWord(enums.valueType.INT)],
        ['size', () => new SaneWord(enums.valueType.INT)],
        ['cap', () => new SaneWord(enums.valueType.INT)],
        ['constraint', (optionDescriptor) => new SaneStructure(new Map([
          ['type', () => new SaneWord(enums.valueType.INT)],
          ['value', (constraint) => {
            if (constraint.type === 0) { // NONE
              return new SaneBytes(0)
            }
            if (constraint.type === 1) {// RANGE
              return new SanePointer(new SaneStructure(new Map([
                ['min', () => new SaneWord(optionDescriptor.type)],
                ['max', () => new SaneWord(optionDescriptor.type)],
                ['quantization', () => new SaneWord(optionDescriptor.type)]
              ])))
            }
            if (constraint.type === 2) {// WORD_LIST
              return new SaneArray((index) => { return new SaneWord(optionDescriptor.type) })
            }
            if (constraint.type === 3) {// STRING_LIST
              return new SaneArray((index) => { return new SaneString() })
            }
          }]
        ]))]
      ])))
    })
  }
}

class ControlOptionParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneStructure(new Map([
      ['info', () => new SaneWord(enums.valueType.INT)],
      ['value_type', () => new SaneWord(enums.valueType.INT)],
      ['value_size', () => new SaneWord(enums.valueType.INT)],
      ['value', (_) => {
        if (_.value_type === 0) { return new SaneArray(() => { return new SaneWord(enums.valueType.BOOL) }) }
        if (_.value_type === 1) { return new SaneArray(() => { return new SaneWord(enums.valueType.INT) }) }
        if (_.value_type === 2) { return new SaneArray(() => { return new SaneWord(enums.valueType.FIXED) }) }
        if (_.value_type === 3) { return new SaneString() }
        if (_.value_type === 4) { return new SaneArray(() => { return new SaneWord() }) }
        if (_.value_type === 5) { return new SaneArray(() => { return new SaneWord() }) }
      }],
      ['resource', () => new SaneString()]
    ]))
  }
}

class GetParametersParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneStructure(new Map([
      ['format', () => new SaneWord(enums.valueType.INT)],
      ['last_frame', () => new SaneWord(enums.valueType.BOOL)],
      ['bytes_per_line', () => new SaneWord(enums.valueType.INT)],
      ['pixels_per_line', () => new SaneWord(enums.valueType.INT)],
      ['lines', () => new SaneWord(enums.valueType.INT)],
      ['depth', () => new SaneWord(enums.valueType.INT)]
    ]))
  }
}

class StartParser extends Parser {
  constructor () {
    super()
    this.buffer = new SaneStructure(new Map([
      ['port', () => new SaneWord(enums.valueType.INT)],
      ['byte_order', () => new SaneWord(enums.valueType.INT)]
    ]))
    this.resource = new SaneString()
  }
  get complete () {
    return this.buffer.complete
  }
  get data () {
    return this.buffer.data
  }
}
