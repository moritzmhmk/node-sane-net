// http://www.sane-project.org/html/doc011.html#s4.2.1

module.exports.string = (str) => {
  if (str.length !== 0 && str.slice(-1) !== '\0') {
    str += '\0'
  }
  var buf = new Buffer(4 + str.length)
  buf.writeUInt32BE(str.length, 0)
  buf.write(str, 4, str.length, 'latin1')
  return buf
}

let valueType = {
  'BOOL': 0,
  'INT': 1,
  'FIXED': 2,
  'STRING': 3,
  'BUTTON': 4,
  'GROUP': 5
}

module.exports.word = (value, type) => {
  var buf = new Buffer(4)
  if (type === valueType.FIXED) {
    value = value * (1 << 16)
  }
  buf.writeUInt32BE(value)
  return buf
}

module.exports.array = (array, itemHandler) => {
  var list = [new Buffer(4)]
  list[0].writeUInt32BE(array.length)
  array.forEach((item) => { list.push(itemHandler(item)) })
  return Buffer.concat(list)
}

module.exports.versionCode = (major, minor, build) => {
  var buf = new Buffer(4)
  buf[0] = major & 0xFF
  buf[1] = minor & 0xFF
  buf.writeUInt16BE(build & 0xFFFF, 2)
  return buf
}
