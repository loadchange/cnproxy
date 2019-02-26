'use strict';

var url = require('url');
var utils = require('../common/utils');
var log = require('../common/log');

function respondFromWebFile(filePath, req, res, next) {
    log.debug('respond with web file: ' + filePath);

    // Fix the host of request header to the web file's host
    var remoteHost = url.parse(filePath).host;
    req.headers && (req.headers.host = remoteHost);

    utils.request({
        url: filePath,
        method: req.method,
        headers: req.headers
    }, function (err, data, proxyRes) {
        if (err) {
            throw err;
        }
        res.writeHead(200, proxyRes.headers);
        res.write(data);
        res.end();
        next();
    });
}

module.exports = respondFromWebFile;