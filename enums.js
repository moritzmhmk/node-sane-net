function makeBidirectional (o) {
  Object.keys(o).forEach((k) => o[o[k]] = k)
}

let rpc = {
  SANE_NET_INIT: 0,
  SANE_NET_GET_DEVICES: 1,
  SANE_NET_OPEN: 2,
  SANE_NET_CLOSE: 3,
  SANE_NET_GET_OPTION_DESCRIPTORS: 4,
  SANE_NET_CONTROL_OPTION: 5,
  SANE_NET_GET_PARAMETERS: 6,
  SANE_NET_START: 7,
  SANE_NET_CANCEL: 8,
  SANE_NET_AUTHORIZE: 9,
  SANE_NET_EXIT: 10
}
makeBidirectional(rpc)
Object.freeze(rpc)
module.exports.rpc = rpc

let status = {
  GOOD: 0,
  UNSUPPORTED: 1,
  CANCELLED: 2,
  DEVICE_BUSY: 3,
  INVAL: 4,
  EOF: 5,
  JAMMED: 6,
  NO_DOCS: 7,
  COVER_OPEN: 8,
  IO_ERROR: 9,
  NO_MEM: 10,
  ACCESS_DENIED: 11
}
makeBidirectional(status)
Object.freeze(status)
module.exports.status = status

let valueType = {
  BOOL: 0,
  INT: 1,
  FIXED: 2,
  STRING: 3,
  BUTTON: 4,
  GROUP: 5
}
makeBidirectional(valueType)
Object.freeze(valueType)
module.exports.valueType = valueType

let unit = {
  NONE: 0,
  PIXEL: 1,
  BIT: 2,
  MM: 3,
  DPI: 4,
  PERCENT: 5,
  MICROSECOND: 6
}
makeBidirectional(unit)
Object.freeze(unit)
module.exports.unit = unit

let cap = {
  SOFT_SELECT: 1,
  HARD_SELECT: 2,
  SOFT_DETECT: 4,
  EMULATED: 8,
  AUTOMATIC: 16,
  INACTIVE: 32,
  ADVANCED: 64
}
makeBidirectional(cap)
Object.freeze(cap)
module.exports.cap = cap

let constraintType = {
  NONE: 0,
  RANGE: 1,
  WORD_LIST: 2,
  STRING_LIST: 3
}
makeBidirectional(constraintType)
Object.freeze(constraintType)
module.exports.constraintType = constraintType

let action = {
  GET_VALUE: 0,
  SET_VALUE: 1,
  SET_AUTO: 2
}
makeBidirectional(action)
Object.freeze(action)
module.exports.action = action

let info = {
  INEXACT: 1,
  RELOAD_OPTIONS: 2,
  RELOAD_PARAMS: 4
}
makeBidirectional(info)
Object.freeze(info)
module.exports.info = info

let frame = {
  GRAY: 0,
  RGB: 1,
  RED: 2,
  GREEN: 3,
  BLUE: 4
}
makeBidirectional(frame)
Object.freeze(frame)
module.exports.frame = frame
