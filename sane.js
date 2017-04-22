const net = require('net')
const EventEmitter = require('events')

const md5 = require('md5')

const sanetypes = require('./sanetypes')
const enums = require('./enums')

class SaneSocket extends EventEmitter {
  constructor () {
    super()
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
        let backend = resource.split('$MD5$')[0]
        this.emit('authorize', backend, (username, password) => {
          this.authorize(resource, username, password, responseParser)
        })
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
    return this.send(buf, new Parser(new SaneWord(enums.valueType.INT), true, false))
  }
  getDevices () {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_DEVICES)
    return this.send(rpcCode, new Parser(
      new SaneArray((index) => {
        return new SanePointer(new SaneStructure(new Map([
          ['name', () => new SaneString()],
          ['vendor', () => new SaneString()],
          ['model', () => new SaneString()],
          ['type', () => new SaneString()]
        ])))
      }),
      true,
      false
    ))
  }
  open (deviceName) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_OPEN)
    var buf = Buffer.concat([rpcCode, sanetypes.string(deviceName)])
    return this.send(buf, new Parser(new SaneWord(enums.valueType.INT), true, true))
  }
  close () {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_CLOSE)
    return this.send(rpcCode, new Parser())
  }
  getOptionDescriptors (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_OPTION_DESCRIPTORS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneArray((index) => {
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
              if (constraint.type === 1) { // RANGE
                return new SanePointer(new SaneStructure(new Map([
                  ['min', () => new SaneWord(optionDescriptor.type)],
                  ['max', () => new SaneWord(optionDescriptor.type)],
                  ['quantization', () => new SaneWord(optionDescriptor.type)]
                ])))
              }
              if (constraint.type === 2) { // WORD_LIST
                return new SaneArray((index) => { return new SaneWord(optionDescriptor.type) })
              }
              if (constraint.type === 3) { // STRING_LIST
                return new SaneArray((index) => { return new SaneString() })
              }
            }]
          ]))]
        ])))
      }),
      false,
      false
    ))
  }
  controlOption (handle, option, action, valueType, valueSize, value) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_CONTROL_OPTION)
    handle = sanetypes.word(handle)
    option = sanetypes.word(option)
    action = sanetypes.word(action)
    value = sanetypes.array(value, (item) => { return sanetypes.word(item, valueType) })
    valueType = sanetypes.word(valueType)
    valueSize = sanetypes.word(valueSize)
    var buf = Buffer.concat([rpcCode, handle, option, action, valueType, valueSize, value])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['info', () => new SaneWord(enums.valueType.INT)],
        ['valueType', () => new SaneWord(enums.valueType.INT)],
        ['valueSize', () => new SaneWord(enums.valueType.INT)],
        ['value', (_) => {
          if (_.valueType === 0) { return new SaneArray(() => { return new SaneWord(enums.valueType.BOOL) }) }
          if (_.valueType === 1) { return new SaneArray(() => { return new SaneWord(enums.valueType.INT) }) }
          if (_.valueType === 2) { return new SaneArray(() => { return new SaneWord(enums.valueType.FIXED) }) }
          if (_.valueType === 3) { return new SaneString() }
          if (_.valueType === 4) { return new SaneArray(() => { return new SaneWord() }) }
          if (_.valueType === 5) { return new SaneArray(() => { return new SaneWord() }) }
        }]
      ])),
      true,
      true
    ))
  }
  getParameters (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_GET_PARAMETERS)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['format', () => new SaneWord(enums.valueType.INT)],
        ['lastFrame', () => new SaneWord(enums.valueType.BOOL)],
        ['bytesPerLine', () => new SaneWord(enums.valueType.INT)],
        ['pixelsPerLine', () => new SaneWord(enums.valueType.INT)],
        ['lines', () => new SaneWord(enums.valueType.INT)],
        ['depth', () => new SaneWord(enums.valueType.INT)]
      ])),
      true,
      false
    ))
  }
  start (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_START)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['port', () => new SaneWord(enums.valueType.INT)],
        ['byteOrder', () => new SaneWord(enums.valueType.INT)]
      ])),
      true,
      true
    ))
  }
  cancel (handle) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_CANCEL)
    handle = sanetypes.word(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(new SaneWord(), false, false))
  }
  authorize (resource, username, password, originalParser) {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_AUTHORIZE)
    var salt = resource.split('$MD5$')[1]
    var pw = '$MD5$' + md5(salt + password)
    var buf = Buffer.concat([rpcCode, sanetypes.string(resource), sanetypes.string(username), sanetypes.string(pw)])
    return this.send(buf, new Parser(originalParser, true, false))
  }
  exit () {
    var rpcCode = sanetypes.word(enums.rpc.SANE_NET_EXIT)
    return this.send(rpcCode, new Parser(new SaneWord(), false, false))
  }
}

module.exports.Socket = SaneSocket

/** Abstract Buffer class */
class SaneBuffer {
  constructor () {
    if (new.target === SaneBuffer) {
      throw new TypeError('Cannot construct SaneBuffer instances directly')
    }
  }

  /**
   * Reset the buffer
   */
  reset () { this.buffer.reset() }

  /**
   * get complete
   * @return {boolean} true when the buffer is complete
   */
  get complete () { return this.buffer.complete }

  /**
   * get the buffer that would result in "data" when parsed
   * @param data
   * @return {Buffer} buffer
   */
  static bufferFor (data) { return data }

  /**
   * get data
   * @return the parsed data
   */
  get data () { return this.buffer.data }

  /**
   * slice bytes from buf to complete this {SaneBuffer}
   * @param {Buffer} buf
   * @return {Buffer} remaining bytes
   */
  sliceFrom (buf) { return this.buffer.sliceFrom(buf) }
}

/**
 * A byte is encoded as an 8 bit value.
 * Since the transport protocol is assumed to be byte-orientd, the bit order is irrelevant.
 * @extends SaneBuffer
 * @param {number} size - number of bytes (defaults to one)
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
 * @extends SaneBuffer
 * @param {enums.status} type - type of value this word encodes
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
 * @extends SaneBuffer
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
 * @extends SaneBuffer
 * @param {SaneBuffer} pointerBuffer - the buffer to store the value of the pointer
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
 * @extends SaneBuffer
 * @param {Map} structDefinition definition of the struct (String => SaneBuffer)
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
 * @extends SaneBuffer
 * @param {function} itemBufferCreator should return a new SaneBuffer, called for every array element.
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
 * @extends SaneBuffer
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

/**
 * Parser authorize event.
 *
 * @event Parser#authorize
 * @property {String} resource - the resource to authorize
 */

/**
 * Parser complete event.
 *
 * @event Parser#complete
 * @property data - the parsed data
 */

/**
 * Parser error event.
 *
 * @event Parser#error
 * @property error - sane status describing the error
 */

/**
 * A Parser differs from a {SaneBuffer} by being an {EventEmitter} and having no bufferFor and reset functions.
 * @emits Parser#authorize
 * @emits Parser#complete
 * @emits Parser#error
 */
class Parser extends EventEmitter {
  /**
   * Create a parser.
   * @param {SaneBuffer} buffer
   * @param {boolean} hasStatus - if status word will be send by server
   * @param {boolean} hasResource - if authentication resource string will be send by server
   */
  constructor (buffer, hasStatus, hasResource) {
    super()
    this.status = new SaneWord(enums.valueType.INT)
    // if there is no status response - set to "GOOD"
    if (!hasStatus) { this.status.sliceFrom(SaneWord.bufferFor(enums.status.GOOD)) }
    this.buffer = buffer || new SaneBytes(0)
    this.resource = hasResource ? new SaneString() : new SaneBytes(0)
  }
  get data () { return this.buffer.data }
  get complete () { return this.status.complete && this.buffer.complete && this.resource.complete }
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
