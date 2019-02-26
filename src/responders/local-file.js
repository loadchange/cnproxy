const fs = require('fs')
const mime = require('mime')
const utils = require('../common/utils')

function respondFromLocalFile(filePath, req, res, next) {
    if (!utils.isAbsolutePath(filePath)) {
        throw new Error('Not a valid file path')
    }

    fs.stat(filePath, (err, stat) => {
        if (err) {
            throw err
        }
        if (!stat.isFile()) {
            throw new Error('The responder is not a file!')
        }

        res.statusCode = 200
        res.setHeader('Content-Length', stat.size)
        res.setHeader('Content-Type', mime.getType(filePath))
        res.setHeader('Server', 'CNPROXY')
        fs.createReadStream(filePath).pipe(res)
    })
    next()
}

module.exports = respondFromLocalFile