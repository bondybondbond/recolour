/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const Jimp = require('jimp')
const replaceColor = require('../')

describe('Recolour', function () {
  this.timeout(60000)

  it('should respect a dual callback / promise API and execute an error-first callback with a Jimp instance', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    }, (err, jimpObject) => {
      if (err) return done(err)

      assert.strictEqual(jimpObject instanceof Jimp, true)

      done()
    })
  })

  it('should respect a dual callback / promise API and fulfil a promise with a Jimp instance', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should fulfil a promise with a Jimp instance when an image is a local path', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should fulfil a promise with a Jimp instance when an image is a remote URL', (done) => {
    replaceColor({
      image: 'https://i.imgur.com/XqNTuzp.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should fulfil a promise with a Jimp instance when an image is a Jimp instance', (done) => {
    Jimp.read('./test/files/watermark.jpg')
      .then((jimpObject) => {
        return replaceColor({
          image: jimpObject,
          colors: {
            type: 'hex',
            targetColor: '#FFB3B5',
            replaceColor: '#FFFFFF'
          }
        })
      })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should fulfil a promise with a Jimp instance when an image is a buffer', (done) => {
    const buffer = fs.readFileSync('./test/files/watermark.jpg')
    replaceColor({
      image: buffer,
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.type" HEX value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.type.replaceColor" AHEX value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFFFF'
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.type" RGB value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'rgb',
        targetColor: [255, 179, 181],
        replaceColor: [255, 255, 255]
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.type.replaceColor" RGBA value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'rgb',
        targetColor: [255, 179, 181],
        replaceColor: [255, 255, 255, 0.5]
      }
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.formula" E76 value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      },
      formula: 'E76'
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.formula" E94 value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      },
      formula: 'E94'
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.formula" E00 value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      },
      formula: 'E00'
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  it('should respect "colors.formula" deltaE value', (done) => {
    replaceColor({
      image: './test/files/watermark.jpg',
      colors: {
        type: 'hex',
        targetColor: '#FFB3B5',
        replaceColor: '#FFFFFF'
      },
      deltaE: 50
    })
      .then((jimpObject) => {
        assert.strictEqual(jimpObject instanceof Jimp, true)

        done()
      })
      .catch(done)
  })

  describe('output option', function () {
    it('should fulfil a promise with a Buffer when output is "buffer"', (done) => {
      replaceColor({
        image: './test/files/watermark.jpg',
        colors: { type: 'hex', targetColor: '#FFB3B5', replaceColor: '#FFFFFF' },
        output: 'buffer'
      })
        .then((result) => {
          assert.strictEqual(result instanceof Buffer, true)

          done()
        })
        .catch(done)
    })

    it('should fulfil a promise with a Buffer when output is "buffer" and outputMime is JPEG', (done) => {
      replaceColor({
        image: './test/files/watermark.jpg',
        colors: { type: 'hex', targetColor: '#FFB3B5', replaceColor: '#FFFFFF' },
        output: 'buffer',
        outputMime: Jimp.MIME_JPEG
      })
        .then((result) => {
          assert.strictEqual(result instanceof Buffer, true)

          done()
        })
        .catch(done)
    })

    it('should fulfil a promise with a base64 data URL when output is "base64"', (done) => {
      replaceColor({
        image: './test/files/watermark.jpg',
        colors: { type: 'hex', targetColor: '#FFB3B5', replaceColor: '#FFFFFF' },
        output: 'base64'
      })
        .then((result) => {
          assert.match(result, /^data:image\/png;base64,/)

          done()
        })
        .catch(done)
    })

    it('should fulfil a promise with a JPEG base64 data URL when output is "base64" and outputMime is JPEG', (done) => {
      replaceColor({
        image: './test/files/watermark.jpg',
        colors: { type: 'hex', targetColor: '#FFB3B5', replaceColor: '#FFFFFF' },
        output: 'base64',
        outputMime: Jimp.MIME_JPEG
      })
        .then((result) => {
          assert.match(result, /^data:image\/jpeg;base64,/)

          done()
        })
        .catch(done)
    })

    it('should fulfil a promise with a Jimp instance when output is "jimp" even if outputMime is set', (done) => {
      replaceColor({
        image: './test/files/watermark.jpg',
        colors: { type: 'hex', targetColor: '#FFB3B5', replaceColor: '#FFFFFF' },
        output: 'jimp',
        outputMime: Jimp.MIME_JPEG
      })
        .then((result) => {
          assert.strictEqual(result instanceof Jimp, true)

          done()
        })
        .catch(done)
    })
  })
})
