const convertColor = require('./utils/convert-color')
const getDelta = require('./utils/get-delta')
const isNumber = require('./utils/is-number')
const _Jimp = require('jimp')
// Fix #18: handle both CJS (Jimp directly) and ESM/webpack builds (Jimp.default)
const Jimp = _Jimp.default || _Jimp
const ReplaceColorError = require('./utils/recolour-error')
const validateColors = require('./utils/validate-colors')

module.exports = ({
  image,
  colors,
  formula = 'E00',
  deltaE = 2.3,
  output = 'jimp',
  outputMime = Jimp.MIME_PNG
} = {}, callback) => {
  if (callback) {
    if (typeof callback !== 'function') {
      throw new ReplaceColorError('PARAMETER_INVALID', 'callback')
    }
  }

  return new Promise((resolve, reject) => {
    callback = callback || ((err, jimpObject) => {
      if (err) return reject(err)
      return resolve(jimpObject)
    })

    if (!image) {
      return callback(new ReplaceColorError('PARAMETER_REQUIRED', 'options.image'))
    }

    // Support array of color pairs for multiple color replacement (Issue #15)
    const colorsList = Array.isArray(colors) ? colors : [colors]

    for (const c of colorsList) {
      const colorsValidationError = validateColors(c)
      if (colorsValidationError) {
        return callback(new ReplaceColorError(colorsValidationError.code, colorsValidationError.field))
      }
    }

    if (!(typeof formula === 'string' && ['E76', 'E94', 'E00'].includes(formula))) {
      return callback(new ReplaceColorError('PARAMETER_INVALID', 'options.formula'))
    }

    if (!(isNumber(deltaE) && deltaE >= 0 && deltaE <= 100)) {
      return callback(new ReplaceColorError('PARAMETER_INVALID', 'options.deltaE'))
    }

    if (!['jimp', 'buffer', 'base64'].includes(output)) {
      return callback(new ReplaceColorError('PARAMETER_INVALID', 'options.output'))
    }

    if (output !== 'jimp' && typeof outputMime !== 'string') {
      return callback(new ReplaceColorError('PARAMETER_INVALID', 'options.outputMime'))
    }

    Jimp.read(image)
      .then((jimpObject) => {
        for (const c of colorsList) {
          const targetLABColor = convertColor(c.type, 'lab', c.targetColor)
          const replaceRGBColor = convertColor(c.type, 'rgb', c.replaceColor)
          const colorDeltaE = isNumber(c.deltaE) ? c.deltaE : deltaE

          jimpObject.scan(0, 0, jimpObject.bitmap.width, jimpObject.bitmap.height, (x, y, idx) => {
            const currentLABColor = convertColor('rgb', 'lab', [
              jimpObject.bitmap.data[idx],
              jimpObject.bitmap.data[idx + 1],
              jimpObject.bitmap.data[idx + 2]
            ])

            if (getDelta(currentLABColor, targetLABColor, formula) <= colorDeltaE) {
              jimpObject.bitmap.data[idx] = replaceRGBColor[0]
              jimpObject.bitmap.data[idx + 1] = replaceRGBColor[1]
              jimpObject.bitmap.data[idx + 2] = replaceRGBColor[2]
              if (replaceRGBColor[3] !== null) jimpObject.bitmap.data[idx + 3] = replaceRGBColor[3]
            }
          })
        }

        if (output === 'buffer') {
          return jimpObject.getBufferAsync(outputMime).then((buf) => callback(null, buf))
        }

        if (output === 'base64') {
          return jimpObject.getBase64Async(outputMime).then((str) => callback(null, str))
        }

        callback(null, jimpObject)
      })
      .catch(callback)
  })
}
