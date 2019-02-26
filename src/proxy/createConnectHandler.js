const net = require('net')
const url = require('url')
const log = require('../common/log')

const localIP = '127.0.0.1'
// create connectHandler function
module.exports = function createConnectHandler(sslConnectInterceptor, fakeServerCenter) {
    // return
    return function connectHandler(req, cltSocket, head) {
        let srvUrl = url.parse(`https://${req.url}`)
        if (typeof sslConnectInterceptor === 'function' && sslConnectInterceptor.call(null, req, cltSocket, head)) {
            fakeServerCenter.getServerPromise(srvUrl.hostname, srvUrl.port).then((serverObj) => {
                connect(req, cltSocket, head, localIP, serverObj.port)
            }, (e) => log.error(e))
        } else {
            connect(req, cltSocket, head, srvUrl.hostname, srvUrl.port)
        }
    }

}

function connect(req, cltSocket, head, hostname, port) {
    let proxySocket = net.connect(port, hostname, () => {
        cltSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-agent: cproxy\r\n\r\n')
        proxySocket.write(head)
        proxySocket.pipe(cltSocket)
        cltSocket.pipe(proxySocket)
    })
    proxySocket.on('error', (e) => log.error(e))
    return proxySocket
}