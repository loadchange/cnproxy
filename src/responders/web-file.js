const url = require('url')
const utils = require('../common/utils')
const log = require('../common/log')

function respondFromWebFile(filePath, req, res, next) {
    log.debug('respond with web file: ' + filePath)

    // Fix the host of request header to the web file's host
    let remoteHost = url.parse(filePath).host
    req.headers && (req.headers.host = remoteHost)

    utils.request({
        url: filePath,
        method: req.method,
        headers: req.headers
    }, (err, data, proxyRes) => {
        if (err) {
            throw err
        }
        res.writeHead(200, proxyRes.headers)
        res.write(data)
        res.end()
        next()
    })
}

module.exports = respondFromWebFile