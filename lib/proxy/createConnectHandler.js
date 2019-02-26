'use strict';

var net = require('net');
var url = require('url');
var log = require('../common/log');

var localIP = '127.0.0.1';
// create connectHandler function
module.exports = function createConnectHandler(sslConnectInterceptor, fakeServerCenter) {
    // return
    return function connectHandler(req, cltSocket, head) {
        var srvUrl = url.parse('https://' + req.url);
        if (typeof sslConnectInterceptor === 'function' && sslConnectInterceptor.call(null, req, cltSocket, head)) {
            fakeServerCenter.getServerPromise(srvUrl.hostname, srvUrl.port).then(function (serverObj) {
                connect(req, cltSocket, head, localIP, serverObj.port);
            }, function (e) {
                return log.error(e);
            });
        } else {
            connect(req, cltSocket, head, srvUrl.hostname, srvUrl.port);
        }
    };
};

function connect(req, cltSocket, head, hostname, port) {
    var proxySocket = net.connect(port, hostname, function () {
        cltSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: cproxy\r\n\r\n');
        proxySocket.write(head);
        proxySocket.pipe(cltSocket);
        cltSocket.pipe(proxySocket);
    });
    proxySocket.on('error', function (e) {
        return log.error(e);
    });
    return proxySocket;
}