// http://www.sane-project.org/html/doc011.html#s4.2.1

module.exports.rpc = {
  'SANE_NET_INIT': 0,
  'SANE_NET_GET_DEVICES': 1,
  'SANE_NET_OPEN': 2,
  'SANE_NET_CLOSE': 3,
  'SANE_NET_GET_OPTION_DESCRIPTORS': 4,
  'SANE_NET_CONTROL_OPTION': 5,
  'SANE_NET_GET_PARAMETERS': 6,
  'SANE_NET_START': 7,
  'SANE_NET_CANCEL': 8,
  'SANE_NET_AUTHORIZE': 9,
  'SANE_NET_EXIT': 10
}

module.exports.status = [
  'SANE_STATUS_GOOD',	/* everything A-OK */
  'SANE_STATUS_UNSUPPORTED',	/* operation is not supported */
  'SANE_STATUS_CANCELLED',	/* operation was cancelled */
  'SANE_STATUS_DEVICE_BUSY',	/* device is busy; try again later */
  'SANE_STATUS_INVAL',		/* data is invalid (includes no dev at open) */
  'SANE_STATUS_EOF',		/* no more data available (end-of-file) */
  'SANE_STATUS_JAMMED',		/* document feeder jammed */
  'SANE_STATUS_NO_DOCS',	/* document feeder out of documents */
  'SANE_STATUS_COVER_OPEN',	/* scanner cover is open */
  'SANE_STATUS_IO_ERROR',	/* error during device I/O */
  'SANE_STATUS_NO_MEM',		/* out of memory */
  'SANE_STATUS_ACCESS_DENIED'
]

module.exports.string = (str) => {
  if (str.length !== 0 && str.slice(-1) !== '\0') {
    str += '\0'
  }
  var buf = new Buffer(4 + str.length)
  buf.writeUInt32BE(str.length, 0)
  buf.write(str, 4, str.length, 'latin1')
  return buf
}

module.exports.versionCode = (major, minor, build) => {
  var buf = new Buffer(4)
  buf[0] = major & 0xFF
  buf[1] = minor & 0xFF
  buf.writeUInt16BE(build & 0xFFFF, 2)
  return buf
}
