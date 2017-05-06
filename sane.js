const net = require('net')
const EventEmitter = require('events')
const Transform = require('stream').Transform

const md5 = require('md5')

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
    var rpcCode = SaneEnum.bufferFor('SANE_NET_INIT', enums.rpc)
    var major = 1
    var minor = 0
    var build = 3
    var versionCode = SaneWord.bufferFor(major & 0xFF << 24 || minor & 0xFF << 16 || build & 0xFFFF)
    var name = SaneString.bufferFor('moritz')
    var buf = Buffer.concat([rpcCode, versionCode, name])
    return this.send(buf, new Parser(new SaneWord(), true, false))
  }
  getDevices () {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_GET_DEVICES', enums.rpc)
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
    var rpcCode = SaneEnum.bufferFor('SANE_NET_OPEN', enums.rpc)
    var buf = Buffer.concat([rpcCode, SaneString.bufferFor(deviceName)])
    return this.send(buf, new Parser(new SaneHandle(), true, true))
  }
  close () {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_CLOSE', enums.rpc)
    return this.send(rpcCode, new Parser())
  }
  getOptionDescriptors (handle) {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_GET_OPTION_DESCRIPTORS', enums.rpc)
    handle = SaneHandle.bufferFor(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneArray((index) => {
        return new SanePointer(new SaneStructure(new Map([
          ['name', () => new SaneString()],
          ['title', () => new SaneString()],
          ['description', () => new SaneString()],
          ['type', () => new SaneEnum(enums.valueType)],
          ['units', () => new SaneEnum(enums.unit)],
          ['size', () => new SaneWord()],
          ['cap', () => new SaneEnumFlags(enums.cap)],
          ['constraint', (optionDescriptor) => new SaneUnion(enums.constraintType, (type) => {
            switch (type) {
              case 'NONE':
                return new SaneBytes(0)
              case 'RANGE':
                return new SanePointer(new SaneStructure(new Map([
                  ['min', () => new SaneWord(optionDescriptor.type)],
                  ['max', () => new SaneWord(optionDescriptor.type)],
                  ['quantization', () => new SaneWord(optionDescriptor.type)]
                ])))
              case 'WORD_LIST':
                return new SaneArray(index => new SaneWord(optionDescriptor.type))
              case 'STRING_LIST':
                return new SaneArray(index => new SaneString())
            }
          })]
        ])))
      }),
      false,
      false
    ))
  }
  getOptionDescriptorsGrouped (handle) {
    return this.getOptionDescriptors(handle).then((options) => {
      let r = []
      let c = r
      options.forEach((option, id) => {
        option.id = id
        if (option.type === 'GROUP') {
          option.children = []
          c = option.children
          r.push(option)
        } else {
          c.push(option)
        }
      })
      return r
    })
  }
  controlOption (handle, option, action, value, valueType) {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_CONTROL_OPTION', enums.rpc)
    handle = SaneHandle.bufferFor(handle)
    option = SaneWord.bufferFor(option)
    action = SaneEnum.bufferFor(action, enums.action)
    switch (valueType) {
      case 'BOOL':
      case 'INT':
      case 'FIXED':
        value = SaneArray.bufferFor([SaneWord.bufferFor(value, valueType)])
        break
      case 'STRING':
        value = SaneString.bufferFor(value)
        break
      case 'BUTTON':
      case 'GROUP':
      default:
        value = SaneArray.bufferFor([new Buffer(1)])
    }
    valueType = SaneEnum.bufferFor(valueType, enums.valueType)
    let valueSize = SaneWord.bufferFor(value.length - 4) // subtract the 4 bytes indicating the length in words
    var buf = Buffer.concat([rpcCode, handle, option, action, valueType, valueSize, value])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['info', () => new SaneEnum(enums.info)],
        ['valueType', () => new SaneEnum(enums.valueType)],
        ['valueSize', () => new SaneWord()],
        ['value', (_) => {
          switch (_.valueType) {
            case 'BOOL':
            case 'INT':
            case 'FIXED':
              return new SaneArray(() => new SaneWord(_.valueType))
            case 'STRING':
              return new SaneString()
            case 'BUTTON':
            case 'GROUP':
              return new SaneArray(() => new SaneWord())
          }
        }]
      ])),
      true,
      true
    ))
  }
  getOption (handle, option) {
    return this.getOptionDescriptors(handle).then((options) => {
      let value = 0
      let valueType = options[option].type
      if (valueType === 'STRING') { value = Array(options[option].size - 1).join(' ') }
      return this.controlOption(handle, option, 'GET_VALUE', value, valueType)
    })
  }
  setOption (handle, option, value) {
    return this.getOptionDescriptors(handle).then(
      (options) => this.controlOption(handle, option, 'SET_VALUE', value, options[option].type)
    )
  }
  getParameters (handle) {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_GET_PARAMETERS', enums.rpc)
    handle = SaneHandle.bufferFor(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['format', () => new SaneEnum(enums.frame)],
        ['lastFrame', () => new SaneWord()],
        ['bytesPerLine', () => new SaneWord()],
        ['pixelsPerLine', () => new SaneWord()],
        ['lines', () => new SaneWord()],
        ['depth', () => new SaneWord()]
      ])),
      true,
      false
    ))
  }
  start (handle) {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_START', enums.rpc)
    handle = SaneHandle.bufferFor(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(
      new SaneStructure(new Map([
        ['port', () => new SaneWord()],
        ['byteOrder', () => new SaneWord()]
      ])),
      true,
      true
    ))
  }
  cancel (handle) {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_CANCEL', enums.rpc)
    handle = SaneHandle.bufferFor(handle)
    var buf = Buffer.concat([rpcCode, handle])
    return this.send(buf, new Parser(new SaneWord(), false, false))
  }
  authorize (resource, username, password, originalParser) {
    var salt = resource.split('$MD5$')[1]
    var rpcCode = SaneEnum.bufferFor('SANE_NET_AUTHORIZE', enums.rpc)
    resource = SaneString.bufferFor(resource)
    username = SaneString.bufferFor(username)
    password = SaneString.bufferFor('$MD5$' + md5(salt + password))
    var buf = Buffer.concat([rpcCode, resource, username, password])
    return this.send(buf, new Parser(originalParser, true, false))
  }
  exit () {
    var rpcCode = SaneEnum.bufferFor('SANE_NET_EXIT', enums.rpc)
    return this.send(rpcCode, new Parser(new SaneWord(), false, false))
  }
}

module.exports.Socket = SaneSocket

/** Abstract Buffer class - base for the implementation of [Sane Types]{@link http://www.sane-project.org/html/doc016.html} */
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
   * slice bytes from buf to complete this {@link SaneBuffer}
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
  static bufferFor (data, valueType) {
    // if (typeof data !== 'number') { throw new Error('data must be a number') } TODO
    var buf = new Buffer(4)
    if (valueType === 'FIXED') { data = data * (1 << 16) }
    buf.writeUInt32BE(data)
    return buf
  }
  get data () {
    let i = this.buffer.data.readInt32BE() // TODO signed or unsinged?
    if (this.type === 'FIXED') { return i / (1 << 16) }
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
 * A string pointer is encoded as a {@link SaneArray} of {@link SaneChar}.
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
 * A handle is encoded like a word.
 * @extends SaneWord
 */
class SaneHandle extends SaneWord {}

/**
 * Enumeration types are encoded like words.
 * @param {Object} definition the enum definition
 * @extends SaneBuffer
 */
class SaneEnum extends SaneBuffer {
  constructor (definition) {
    super()
    this.definition = definition
    this.buffer = new SaneWord()
  }
  /**
   * @param {String} data the enum value
   * @param {Object} definition the enum definition
   */
  static bufferFor (data, definition) {
    return SaneWord.bufferFor(definition[data])
  }
  /**
   * @return {String} representing the enum value according to the enum definition
   */
  get data () {
    return this.definition[this.buffer.data]
  }
}

/**
 * Enumeration representing flags rather than single values
 * @param {Object} definition the enum definition
 * @extends SaneEnum
 */
class SaneEnumFlags extends SaneEnum {
  /**
   * @param {String} data the set flags
   * @param {Object} definition the enum definition
   */
  static bufferFor (data, definition) {
    let word = 0
    data.forEach((flag) => { word |= this.definition[flag] })
    return SaneWord.bufferFor(word)
  }
  /**
   * @return {Array} list of set flags
   */
  get data () {
    let flags = []
    let word = this.buffer.data
    for (let i = 0; i < 32; i++) {
      let set = word & 1 << i
      set && this.definition[set] && flags.push(this.definition[set])
    }
    return flags
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
    this.isNullBuffer = new SaneWord()
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
 * An array is encoded by a word that indicates the length of the array
 * followed by the values of the elements in the array.
 * The length may be zero in which case no bytes are encoded for the element values.
 * @extends SaneBuffer
 * @param {function} itemBufferCreator should return a new SaneBuffer, called for every array element.
 */
class SaneArray extends SaneBuffer {
  constructor (itemBufferCreator) {
    super()
    this.lengthBuffer = new SaneWord()
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
    let array = this.buffers.map((buffer) => { return buffer ? buffer.data : undefined })
    if (array.length && array[array.length - 1] === null) { array.pop() } // null terminated arrays
    return array
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
 * A structure is encoded by simply encoding the structure members in the order in which they appear.
 * @extends SaneBuffer
 * @param {Map} structDefinition definition of the struct (String => {@link SaneBuffer})
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
 * A union is encoded by a tag value that indicates which of the union members is the active one
 * and the union itself (encoded simply by encoding the value of the currently active member).
 * @extends SaneBuffer
 * @param {function} unionBufferCreator should return a new {@link SaneBuffer}, called with the tag as argument.
 */
class SaneUnion extends SaneBuffer {
  constructor (typeEnum, unionBufferCreator) {
    super()
    this.unionBufferCreator = unionBufferCreator
    this.buffer = new SaneStructure(new Map([
      ['type', () => new SaneEnum(typeEnum)],
      ['value', union => this.unionBufferCreator(union.type)]
    ]))
  }
}

/**
 * A Parser differs from a {@link SaneBuffer} by being an {@link EventEmitter} and having no bufferFor and reset functions.
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
    this.status = new SaneEnum(enums.status)
    // if there is no status response - set to "GOOD"
    if (!hasStatus) { this.status.sliceFrom(SaneEnum.bufferFor('GOOD', enums.status)) }
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
      if (this.status.data !== 'GOOD') {
        console.log('error', this.status.data)
        this.emit('error', this.status.data)
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
 * Transforms the image stream send by SANE into a pure pixel stream.
 * (The SANE stream contains length markers splitting the stream in chunks)
 * @extends Transform
 */
class ImageTransform extends Transform {
  constructor () {
    super()
    this.bytesLeft = 0
  }
  _transform (data, encoding, done) {
    console.log('-> transform')
    if (this.rest) {
      data = Buffer.concat([this.rest, data])
      delete this.rest
    }
    while (data.length) {
      if (this.bytesLeft === 0) {
        if (data.length < 4) { break } // cant read 4 bytes (int32)
        this.bytesLeft = data.readInt32BE() // read the chunk length marker
        if (this.bytesLeft === -1) { break } // end of SANE pixel stream
        data = data.slice(4) // remove the length marker
      }
      let bytes = data.slice(0, this.bytesLeft)
      data = data.slice(bytes.length) // remove the read bytes
      this.bytesLeft -= bytes.length // substract the number of read bytes
      this.push(bytes) // push the read bytes out
    }
    return done()
  }
}

module.exports.ImageTransform = ImageTransform
